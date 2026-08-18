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

      for (const company of targets) {
        if (signal.aborted) break;

        let jobs;
        try {
          jobs = await discoverAtsJobs(company);
        } catch (e) {
          await send(`⚠ ${company.name}: discovery failed — ${e.message}`);
          continue;
        }

        // No eligibility filtering — apply to every posting a tracked company
        // has open, not just ones that look like an exact-level match.
        if (!jobs.length) continue;
        discovered += jobs.length;

        for (const job of jobs) {
          if (signal.aborted) break;

          const linkKey = (job.link || '').split('?')[0];
          if (!linkKey || skippedLinks.has(linkKey) || appliedLinks.has(job.link)) continue;

          await send(`⚡ Applying: ${job.title} at ${company.name} (${company.atsType})...`);
          // Belt-and-suspenders: applyToPortalJob has its own internal timeouts,
          // but a single stuck job (e.g. a hung network call inside it) must
          // never be able to block the rest of this sequential run.
          const result = await Promise.race([
            applyToPortalJob(browser, { ...job, companyName: company.name }),
            new Promise(resolve => setTimeout(() => resolve({ success: false, reason: 'job-timed-out' }), 90000)),
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

          if ((appliedEntries.length + skippedEntries.length) >= 10) {
            if (appliedEntries.length) { await recordApplied(appliedEntries).catch(() => {}); appliedEntries.length = 0; }
            if (skippedEntries.length) { await recordSkipped(skippedEntries).catch(() => {}); skippedEntries.length = 0; }
            await send(`💾 Checkpoint: ${applied} applied, ${skipped} skipped so far`);
          }

          await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));
        }
      }

      if (appliedEntries.length) await recordApplied(appliedEntries).catch(() => {});
      if (skippedEntries.length) await recordSkipped(skippedEntries).catch(() => {});

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
