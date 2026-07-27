export const maxDuration = 600;
export const dynamic = 'force-dynamic';

import { readCompanies, addCompany, upsertJobsByLink, readSkippedLinks, readApplied } from '@/lib/db';
import { scrapeNaukriBroad } from '@/lib/naukri-broad-search';
import { filterEligibleJobs } from '@/lib/matcher';
import { analyzeJob } from '@/lib/ai';
import { buildCompanyRecord } from '@/lib/company-utils';
import { isExcludedCompany, getExcludedCompanies } from '@/lib/exclusions';
import { getBrowser } from '@/lib/browser';
import { startRun, finishRun, isRunning } from '@/lib/naukriBroadRunState';

export async function POST(request) {
  const { pagesPerSearch = 5 } = await request.json().catch(() => ({}));

  const encoder = new TextEncoder();
  const stream  = new TransformStream();
  const writer  = stream.writable.getWriter();
  const send    = (msg) => writer.write(encoder.encode(`data: ${JSON.stringify({ message: msg })}\n\n`)).catch(() => {});

  if (isRunning()) {
    await send('⚠ A broad Naukri search is already running. Skipping this trigger.');
    await writer.close().catch(() => {});
    return new Response(stream.readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
    });
  }

  const controller = startRun();
  const signal = controller.signal;

  (async () => {
    let browser;
    let connected = false;
    try {
      ({ browser, connected } = await getBrowser({
        headless: process.env.APPLY_HEADLESS !== 'false',
        requireConnected: false,
        preferConnected: false,
      }));

      await send(`🔎 Broad search: ${pagesPerSearch} page(s) per role/city combination...`);
      const raw = await scrapeNaukriBroad(browser, {
        pagesPerSearch,
        onProgress: send,
        signal,
      });

      if (!raw.length) {
        await send('DONE: No listings returned.');
        return;
      }

      // Same eligibility gate as the per-company flow (title / experience /
      // India location), so nothing gets in that the apply step would reject.
      const { eligible, excluded } = filterEligibleJobs(raw, Number.MAX_SAFE_INTEGER);
      await send(`ℹ ${eligible.length} eligible after filtering (dropped ${excluded.title} title, ${excluded.location} location, ${excluded.experience} experience).`);

      // Drop anything already attempted so the "new" count is honest.
      const skipped = await readSkippedLinks();
      const appliedLinks = new Set((await readApplied()).map(a => a.jobLink));
      const untried = eligible.filter(j => {
        const k = (j.link || '').split('?')[0];
        return k && !skipped.has(k) && !appliedLinks.has(j.link) && !appliedLinks.has(k);
      });
      await send(`ℹ ${untried.length} never-attempted (the rest were already applied to or permanently skipped).`);

      if (!untried.length) {
        await send('DONE: Nothing new to add.');
        return;
      }

      // Register unknown posting companies so jobs attach to a real record and
      // show up in the dashboard grouped correctly.
      const existing = await readCompanies();
      const knownIds = new Set(existing.map(c => c.id));
      const excludedNames = getExcludedCompanies();
      let createdCompanies = 0;
      const finalJobs = [];

      for (const job of untried) {
        const name = job.postingCompanyName;
        if (name && isExcludedCompany(name, excludedNames)) continue; // freelance client / current employer

        if (job.companyId && !knownIds.has(job.companyId) && name) {
          try {
            await addCompany(buildCompanyRecord({
              id: job.companyId,
              name,
              locations: job.location ? [job.location] : [],
              autoDiscovered: true,
            }));
            knownIds.add(job.companyId);
            createdCompanies++;
          } catch {
            // already exists (race) — fine, the job still attaches to the id
            knownIds.add(job.companyId);
          }
        }
        const { postingCompanyName, ...rest } = job;
        finalJobs.push(rest);
      }

      if (createdCompanies) await send(`🏢 Registered ${createdCompanies} newly-seen company(s).`);

      await send(`🧠 Scoring ${finalJobs.length} job(s)...`);
      const scored = [];
      for (const job of finalJobs) {
        if (signal.aborted) break;
        const analysis = await analyzeJob(job).catch(() => ({}));
        scored.push({ ...job, ...analysis });
      }

      const inserted = await upsertJobsByLink(scored);
      await send(
        signal.aborted
          ? `STOPPED: Added ${inserted} new job(s) before stopping.`
          : `DONE: Added ${inserted} new job(s) ready to apply to (was 0 fresh before this run).`
      );
    } catch (e) {
      await send(`FATAL: ${e.message}`);
    } finally {
      if (browser && !connected) await browser.close().catch(() => {});
      finishRun();
      await writer.close().catch(() => {});
    }
  })();

  return new Response(stream.readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
  });
}
