export const maxDuration = 600;
export const dynamic = 'force-dynamic';

import { readCompanies, recordApplied, recordSkipped, readActiveSkippedLinks, readApplied } from '@/lib/db';
import { isExcludedCompany, getExcludedCompanies } from '@/lib/exclusions';
import { discoverAtsJobs } from '@/lib/company-portal-discovery';
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
const AUTO_SUBMIT_ATS = ['greenhouse', 'lever', 'ashby'];
const DISCOVER_ONLY_ATS = ['workday', 'smartrecruiters'];

// Board discovery is a few small JSON fetches per company — network-bound, so
// it can run far wider than the core count. Measured: 414 boards in 27s at 12.
const DISCOVER_CONCURRENCY = Number(process.env.PORTAL_DISCOVER_CONCURRENCY) || 12;

// Applying is the opposite: each slot is a live Chrome tab running layout and
// script for a real application form, so this is bounded by CPU, not network.
// Default 3 is sized for the 2-vCPU box — enough to keep both cores busy while
// one tab blocks on navigation, without pushing into swap-and-timeout territory
// where every job starts failing at once. Raise it only on a bigger machine.
const APPLY_CONCURRENCY = Number(process.env.PORTAL_APPLY_CONCURRENCY) || 3;

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
      const companies = await readCompanies();
      const excluded = getExcludedCompanies();
      // Retry-aware, like the Naukri queue: a job skipped for a form error the
      // filler has since learned to handle (custom comboboxes, multi-step
      // wizards) comes back after its cooldown instead of being written off.
      const skippedLinks = await readActiveSkippedLinks();
      const appliedLinks = new Set((await readApplied()).map(a => a.jobLink));

      // ATS discovery (slug-guessing + board-ownership verification) now runs on
      // its own cron (/api/ats-sweep) instead of inline here — that sequential
      // per-company fetch loop (up to 500+ companies, 15s timeout each) could
      // block this run's very first apply for the better part of an hour, which
      // is exactly why runs looked "stopped": they were still stuck discovering,
      // never got to applying before the request timed out.

      // Lever and Ashby first: Greenhouse job pages sit behind an invisible
      // reCAPTCHA that we abort on, so processing them first just spends the
      // run's time on companies that can't be submitted to anyway.
      const atsPriority = { lever: 0, ashby: 1, greenhouse: 2 };
      const targets = companies
        .filter(c => AUTO_SUBMIT_ATS.includes(c.atsType) && c.atsSlug && !isExcludedCompany(c.name, excluded))
        .sort((a, b) => (atsPriority[a.atsType] ?? 9) - (atsPriority[b.atsType] ?? 9));
      const discoverOnlyCount = companies.filter(c => DISCOVER_ONLY_ATS.includes(c.atsType)).length;

      await send(`ℹ ${targets.length} companies on Greenhouse/Lever/Ashby to scan (of ${companies.length} tracked)${discoverOnlyCount ? `; ${discoverOnlyCount} Workday/SmartRecruiters companies are discovered but not auto-submitted` : ''}.`);

      if (!targets.length && !discoverOnlyCount) {
        await send('DONE: No ATS-hosted companies found yet. Tag companies with an atsType + atsSlug (Add Company modal), or set a careersUrl so ATS auto-detection can find one.');
        return;
      }

      ({ browser, connected } = await getBrowser({
        headless: process.env.APPLY_HEADLESS === 'true',
        requireConnected: false,
        preferConnected: true,
      }));

      let applied = 0;
      let skipped = 0;
      let discovered = 0;
      const appliedEntries = [];
      const skippedEntries = [];

      // ── Phase 1: discover every board in parallel ────────────────────────
      // Previously discovery and applying were interleaved in one sequential
      // walk, so a slow board held up applications and a board with nothing
      // open still cost its full round-trip before the next one started.
      // Splitting them means the apply pool starts with the whole work-list
      // and never idles waiting on a fetch.
      await send(`🔎 Discovering open roles across ${targets.length} board(s)...`);
      const queue = [];
      await mapWithConcurrency(targets, DISCOVER_CONCURRENCY, async (company) => {
        if (signal.aborted) return;
        let jobs = [];
        try {
          jobs = await discoverAtsJobs(company);
        } catch (e) {
          await send(`⚠ ${company.name}: discovery failed — ${e.message}`);
          return;
        }
        // No eligibility filtering — apply to every posting a tracked company
        // has open, not just ones that look like an exact-level match.
        discovered += jobs.length;
        for (const job of jobs) {
          const linkKey = (job.link || '').split('?')[0];
          if (!linkKey || skippedLinks.has(linkKey) || appliedLinks.has(job.link)) continue;
          // Guard against the same posting arriving from two company records
          // that resolved to the same board slug.
          if (queue.some(q => q.linkKey === linkKey)) continue;
          queue.push({ linkKey, job, company });
        }
      });

      await send(`📋 ${discovered} posting(s) on those boards; ${queue.length} not yet attempted. Applying ${APPLY_CONCURRENCY} at a time...`);

      // ── Phase 2: apply with a bounded pool of concurrent tabs ────────────
      const flush = async () => {
        if (appliedEntries.length) { await recordApplied(appliedEntries.splice(0)).catch(() => {}); }
        if (skippedEntries.length) { await recordSkipped(skippedEntries.splice(0)).catch(() => {}); }
      };

      await mapWithConcurrency(queue, APPLY_CONCURRENCY, async ({ linkKey, job, company }) => {
        if (signal.aborted) return;

        await send(`⚡ Applying: ${job.title} at ${company.name} (${company.atsType})...`);
        // Belt-and-suspenders: applyToPortalJob has its own internal timeouts,
        // but a single stuck job (e.g. a hung network call inside it) must
        // never be able to block the whole pool.
        const result = await Promise.race([
          applyToPortalJob(browser, { ...job, companyName: company.name }),
          new Promise(resolve => setTimeout(() => resolve({ success: false, reason: 'job-timed-out' }), 120000)),
        ]);

        if (result.success) {
          applied++;
          appliedLinks.add(job.link);
          appliedEntries.push({
            companyId: company.id,
            companyName: company.name,
            jobTitle: job.title,
            jobLink: job.link,
            source: 'company-portal',
          });
          await send(`✓ Applied: ${job.title} at ${company.name} (${result.reason})`);
        } else {
          skipped++;
          skippedLinks.add(linkKey);
          skippedEntries.push({ link: linkKey, reason: result.reason });
          const note = result.captcha ? ' — needs manual completion (CAPTCHA)' : '';
          await send(`○ Skipped: ${job.title} at ${company.name} — ${result.reason}${note}`);
        }

        if (appliedEntries.length + skippedEntries.length >= 20) {
          await flush();
          await send(`💾 Checkpoint: ${applied} applied, ${skipped} skipped of ${queue.length}`);
        }

        // Per-worker jitter. With a pool this staggers the tabs against each
        // other instead of letting them march in lockstep at the same ATS.
        await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));
      });

      await flush();

      if (signal.aborted) {
        await send(`STOPPED: Applied to ${applied} job(s) before stopping. ${skipped} skipped.`);
      } else {
        await send(`DONE: Scanned ${targets.length} companies, ${discovered} eligible job(s) found, applied to ${applied}, skipped ${skipped}.`);
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
