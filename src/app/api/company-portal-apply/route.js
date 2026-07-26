export const maxDuration = 600;
export const dynamic = 'force-dynamic';

import { readCompanies, updateCompany, recordApplied, recordSkipped, readSkippedLinks, readApplied } from '@/lib/db';
import { isExcludedCompany, getExcludedCompanies } from '@/lib/exclusions';
import { discoverAtsJobs, detectAtsFromUrl } from '@/lib/company-portal-discovery';
import { filterGlobalEligibleJobs } from '@/lib/matcher';
import { applyToPortalJob } from '@/lib/generic-form-apply';
import { getBrowser } from '@/lib/browser';
import { startRun, finishRun, isRunning } from '@/lib/companyPortalRunState';

// Workday isn't here — discovery works (public CXS job-listing API), but
// auto-submit isn't built yet (typically needs per-tenant account creation
// and is more CAPTCHA-prone). Those listings are discovered but not applied.
const AUTO_SUBMIT_ATS = ['greenhouse', 'lever', 'ashby'];

export async function POST() {
  const encoder = new TextEncoder();
  const stream  = new TransformStream();
  const writer  = stream.writable.getWriter();
  const send    = (msg) => writer.write(encoder.encode(`data: ${JSON.stringify({ message: msg })}\n\n`));

  if (isRunning()) {
    await send('⚠ A company-portal apply run is already in progress. Stop it first if you want to restart.');
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
      const companies = await readCompanies();
      const excluded = getExcludedCompanies();
      const skippedLinks = await readSkippedLinks();
      const appliedLinks = new Set((await readApplied()).map(a => a.jobLink));

      // Backfill ATS type for companies that have a careersUrl but weren't
      // tagged yet — grows coverage automatically as more companies are tracked.
      let detectedCount = 0;
      for (const company of companies) {
        if (company.atsType && company.atsType !== 'naukri' && company.atsType !== 'unknown') continue;
        if (!company.careersUrl) continue;
        const found = await detectAtsFromUrl(company.careersUrl).catch(() => null);
        if (found) {
          await updateCompany(company.id, found).catch(() => {});
          Object.assign(company, found);
          detectedCount++;
        }
      }
      if (detectedCount) await send(`ℹ Auto-detected ATS platform for ${detectedCount} company(s).`);

      // Lever and Ashby first: Greenhouse job pages sit behind an invisible
      // reCAPTCHA that we abort on, so processing them first just spends the
      // run's time on companies that can't be submitted to anyway.
      const atsPriority = { lever: 0, ashby: 1, greenhouse: 2 };
      const targets = companies
        .filter(c => AUTO_SUBMIT_ATS.includes(c.atsType) && c.atsSlug && !isExcludedCompany(c.name, excluded))
        .sort((a, b) => (atsPriority[a.atsType] ?? 9) - (atsPriority[b.atsType] ?? 9));
      const workdayCount = companies.filter(c => c.atsType === 'workday').length;

      await send(`ℹ ${targets.length} companies on Greenhouse/Lever/Ashby to scan (of ${companies.length} tracked)${workdayCount ? `; ${workdayCount} Workday companies will be logged but not auto-submitted` : ''}.`);

      if (!targets.length && !workdayCount) {
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

        const { eligible } = filterGlobalEligibleJobs(jobs, 25);
        if (!eligible.length) continue;
        discovered += eligible.length;

        for (const job of eligible) {
          if (signal.aborted) break;

          const linkKey = (job.link || '').split('?')[0];
          if (!linkKey || skippedLinks.has(linkKey) || appliedLinks.has(job.link)) continue;

          await send(`⚡ Applying: ${job.title} at ${company.name} (${company.atsType})...`);
          const result = await applyToPortalJob(browser, { ...job, companyName: company.name });

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
      if (browser && !connected) await browser.close().catch(() => {});
      finishRun();
      await writer.close().catch(() => {});
    }
  })();

  return new Response(stream.readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
  });
}
