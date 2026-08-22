export const maxDuration = 600;
export const dynamic = 'force-dynamic';

import os from 'os';

import { recordApplied, recordSkipped, claimPortalJobs, markPortalJob, releaseStalePortalJobs, portalQueueStats, countAppliedToday } from '@/lib/db';
import { applyToPortalJob } from '@/lib/generic-form-apply';
import { getBrowser, closeBrowserSafely } from '@/lib/browser';
import { startRun, finishRun, isRunning } from '@/lib/companyPortalRunState';

// Neither Workday nor SmartRecruiters can be auto-submitted, for the same
// reason from opposite directions — the form isn't reachable headlessly.
// Workday typically wants a per-tenant account first. SmartRecruiters was
// added here and then pulled back out after direct measurement: its postings
// API is public and works well for discovery, but the "I'm interested" button
// hands off to a `oneclick-ui` SPA that renders a completely empty body under
// headless Chrome (verified at 5s, 13s and 21s of wait). Listing it as
// auto-submittable would produce nothing but no-form-fields-found skips.
// Both are therefore discovered and surfaced, but not applied to.
// Every platform here had its apply form verified fillable under headless
// Chrome: real fields, a file input, and a reachable submit control.
const AUTO_SUBMIT_ATS = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'breezy', 'teamtailor'];

// Discovered and surfaced, but never auto-submitted, each for a measured
// reason: Workday wants a per-tenant account; SmartRecruiters hands off to a
// oneclick-ui SPA that renders an empty body headlessly; JazzHR and Personio
// render a real form but expose no reachable submit even after the consent
// banner is dismissed and the page scrolled.
const DISCOVER_ONLY_ATS = ['workday', 'smartrecruiters', 'jazzhr', 'personio'];

// Board discovery is a few small JSON fetches per company — network-bound, so
// it can run far wider than the core count. Measured: 414 boards in 27s at 12.
const DISCOVER_CONCURRENCY = Number(process.env.PORTAL_DISCOVER_CONCURRENCY) || 12;

// Applying is the opposite: each slot is a live Chrome tab running layout and
// script for a real application form, so this is bounded by CPU, not network.
// Default 3 is sized for the 2-vCPU box — enough to keep both cores busy while
// one tab blocks on navigation, without pushing into swap-and-timeout territory
// where every job starts failing at once. Raise it only on a bigger machine.
// Auto-sized from the host's actual core count so a server upgrade takes
// effect without editing config, while PORTAL_APPLY_CONCURRENCY still wins
// when set. Reserve one core for Node/Mongo, then two apply tabs per remaining
// core — a tab spends most of its life blocked on navigation, not computing.
// Capped at 16: past that the bottleneck stops being CPU and becomes the ATS.
function autoConcurrency() {
  const cores = os.cpus()?.length || 2;
  return Math.max(2, Math.min(16, (cores - 1) * 2));
}

// A tick must finish inside its cron interval. If it overruns, the next tick
// is refused by isRunning() and — worse — the SSE client gives up, aborting
// the run and stranding every claimed-but-unprocessed row as in-progress.
// Observed in production: stranded rows grew 48 -> 93 while pending fell to
// 111, i.e. the queue was leaking into a state nothing was draining.
//
// Claiming only what can be finished in the window prevents the strand at
// source, rather than relying on the stale-release to mop it up afterwards.
const TICK_BUDGET_MS = Number(process.env.PORTAL_TICK_BUDGET_MS) || 8 * 60 * 1000;
const APPLY_CONCURRENCY = Number(process.env.PORTAL_APPLY_CONCURRENCY) || autoConcurrency();

async function mapWithConcurrency(items, limit, fn) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i).catch(() => {});
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function POST(request) {
  const reqBody = await request.json().catch(() => ({}));
  const encoder = new TextEncoder();
  const stream  = new TransformStream();
  const writer  = stream.writable.getWriter();
  const send    = (msg) => writer.write(encoder.encode(`data: ${JSON.stringify({ message: msg })}\n\n`)).catch(() => {});

  if (isRunning()) {
    await send('⚠ A company-portal apply run is already in progress. Stop it first if you want to restart.');
    await writer.close().catch(() => {});
    return new Response(stream.readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
    });
  }

  const controller = startRun();
  const signal = controller.signal;

  // Same fix as /api/scrape: without this, a client that gives up (curl
  // --max-time from the cron script) leaves this loop running forever
  // server-side — isRunning() never clears, so every later cron tick just
  // gets "already in progress" while the orphaned run keeps holding the
  // shared browser lock and grinding through the company list alone.
  request.signal?.addEventListener?.('abort', () => controller.abort());

  (async () => {
    let browser;
    let connected = false;

    try {
      // Continuous mode. This route is now a fast queue DRAINER rather than a
      // discovery sweep. It used to fetch every live board before submitting
      // anything: measured at 52ms/board across 13,385 boards that is 11.6
      // minutes of discovery before the first application — 78% of a
      // 15-minute cycle. /api/portal-queue/refresh fills the queue on a slow
      // cadence; this drains it on a fast one, so a tick starts submitting
      // within seconds and can safely run every few minutes.
      // Sized to the box rather than a fixed 60. With answering now costing
      // ~1s instead of ~38s a job runs about 20s, so a 2-core host at
      // concurrency 2 clears roughly 2 x (8min / 20s) = 48 per tick; the 0.8
      // factor leaves headroom for the slow tail.
      const perJobMs = Number(process.env.PORTAL_AVG_JOB_MS) || 20000;
      const fitsInWindow = Math.floor((TICK_BUDGET_MS / perJobMs) * APPLY_CONCURRENCY * 0.8);
      const batchSize = Number(reqBody.batchSize) || Number(process.env.PORTAL_APPLY_BATCH) || Math.max(8, fitsInWindow);
      const dailyCap  = Number(reqBody.dailyCap)  || Number(process.env.PORTAL_DAILY_CAP)  || 2000;

      // 12 minutes, not 30: a stranded row should come back on the very next
      // tick, not three ticks later.
      const released = await releaseStalePortalJobs({ olderThanMinutes: Number(process.env.PORTAL_STALE_MINUTES) || 12 });
      if (released) await send(`↻ Returned ${released} stalled job(s) to pending.`);

      // Applications are irreversible, so the cap is measured against what was
      // actually recorded today, not a per-run counter that resets each tick.
      const alreadyToday = await countAppliedToday('company-portal');
      const remainingToday = Math.max(0, dailyCap - alreadyToday);
      if (!remainingToday) {
        const st = await portalQueueStats();
        await send(`DONE: daily cap reached — ${alreadyToday}/${dailyCap} already submitted today. ${st.pending} still queued.`);
        return;
      }

      const claimed = await claimPortalJobs(Math.min(batchSize, remainingToday));
      if (!claimed.length) {
        const st = await portalQueueStats();
        await send(`DONE: queue empty (${st.applied} applied, ${st.skipped} skipped all-time). Run POST /api/portal-queue/refresh to discover more.`);
        return;
      }

      await send(`ℹ ${claimed.length} job(s) claimed · ${alreadyToday}/${dailyCap} applied today · concurrency ${APPLY_CONCURRENCY} (${os.cpus()?.length || '?'} cores).`);

      ({ browser, connected } = await getBrowser({
        headless: process.env.APPLY_HEADLESS === 'true',
        requireConnected: false,
        preferConnected: true,
        // Greenhouse (and others) run bot-detection that a plain Puppeteer
        // browser trips — this is what actually applies the stealth evasions
        // now; importing the plugin elsewhere without this never did.
        useStealth: true,
      }));

      let applied = 0;
      let skipped = 0;
      const appliedEntries = [];
      const skippedEntries = [];

      const flush = async () => {
        if (appliedEntries.length) await recordApplied(appliedEntries.splice(0)).catch(() => {});
        if (skippedEntries.length) await recordSkipped(skippedEntries.splice(0)).catch(() => {});
      };

      const deadline = Date.now() + TICK_BUDGET_MS;
      const unprocessed = [];

      await mapWithConcurrency(claimed, APPLY_CONCURRENCY, async (job) => {
        if (signal.aborted || Date.now() > deadline) {
          // Hand it straight back rather than leaving it claimed — an
          // abandoned in-progress row is invisible to the queue until the
          // stale sweep notices it.
          unprocessed.push(job);
          await markPortalJob(job.link, 'pending', null);
          return;
        }

        await send(`⚡ Applying: ${job.title} at ${job.companyName} (${job.atsType})...`);
        const result = await Promise.race([
          applyToPortalJob(browser, {
            link: job.link,
            title: job.title,
            atsType: job.atsType,
            companyName: job.companyName,
            location: job.location,
          }),
          // 60s, down from 120s. Timeouts were 38 of 39 on Greenhouse and the
          // cause was answering, not the page: 28 LLM calls totalling 37.8s on
          // one form. With rules and a cross-run cache that is ~1s, so 120s is
          // no longer buying anything except two minutes of a scarce slot.
          new Promise(resolve => setTimeout(() => resolve({ success: false, reason: 'job-timed-out' }), Number(process.env.PORTAL_JOB_TIMEOUT_MS) || 60000)),
        ]);

        if (result.success) {
          applied++;
          await markPortalJob(job.link, 'applied', result.reason);
          appliedEntries.push({
            companyId: job.companyId,
            companyName: job.companyName,
            jobTitle: job.title,
            jobLink: job.link,
            source: 'company-portal',
            // Never persisted before — the 2,104 pre-fix "applied" records
            // this reason field could have flagged as fake had to be
            // identified by commit timestamp instead, since every one of
            // them has reason: null. Storing it going forward means that
            // never has to happen again.
            reason: result.reason,
          });
          await send(`✓ Applied: ${job.title} at ${job.companyName} (${result.reason})`);
        } else {
          skipped++;
          await markPortalJob(job.link, 'skipped', result.reason);
          skippedEntries.push({ link: job.link, reason: result.reason });
          const note = result.captcha ? ' — needs manual completion (CAPTCHA)' : '';
          // Name the fields the repair loop could not resolve. Without this a
          // validation failure is an opaque reason string and there is no way
          // to tell which question the filler doesn't understand yet.
          const detail = result.unresolved?.length
            ? ` [unresolved: ${result.unresolved.slice(0, 4).join(', ')}]`
            : '';
          await send(`○ Skipped: ${job.title} at ${job.companyName} — ${result.reason}${note}${detail}`);
        }

        if (appliedEntries.length + skippedEntries.length >= 20) {
          await flush();
          await send(`💾 Checkpoint: ${applied} applied, ${skipped} skipped of ${claimed.length}`);
        }

        await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));
      });

      await flush();

      if (unprocessed.length) {
        await send(`↩ Returned ${unprocessed.length} unstarted job(s) to pending (tick budget reached).`);
      }

      const st = await portalQueueStats();
      if (signal.aborted) {
        await send(`STOPPED: applied ${applied}, skipped ${skipped} before stopping. ${st.pending} still queued.`);
      } else {
        await send(`DONE: applied ${applied}, skipped ${skipped} this batch. ${alreadyToday + applied}/${dailyCap} today. ${st.pending} still queued.`);
      }
    } catch (e) {
      await send(`FATAL: ${e.message}`);
    } finally {
      await closeBrowserSafely(browser, connected);
      finishRun();
      await writer.close().catch(() => {});
    }
  })();

  return new Response(stream.readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
  });
}
