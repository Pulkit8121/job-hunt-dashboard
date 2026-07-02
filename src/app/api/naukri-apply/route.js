export const maxDuration = 600;
export const dynamic = 'force-dynamic';

import { readJobs, readCompanies, recordApplied, updateJob, recordSkipped, readSkippedLinks } from '@/lib/db';
import { naukriLogin, naukriEasyApply } from '@/lib/naukri';
import { getBrowser, getReusablePage } from '@/lib/browser';
import { isExcludedCompany, getExcludedCompanies } from '@/lib/exclusions';

export async function POST(request) {
  const email    = process.env.NAUKRI_EMAIL;
  const password = process.env.NAUKRI_PASSWORD;

  const encoder = new TextEncoder();
  const stream  = new TransformStream();
  const writer  = stream.writable.getWriter();
  const send    = (msg) => writer.write(encoder.encode(`data: ${JSON.stringify({ message: msg })}\n\n`));

  (async () => {
    let browser;
    let connected = false;

    try {
      const allJobs = await readJobs();
      const companies = await readCompanies();
      const companyMap = Object.fromEntries(companies.map(c => [c.id, c.name]));

      // Load permanently skipped links (company website, no button, etc.)
      const skippedLinks = await readSkippedLinks();

      // Freelance-client companies to never apply to
      const excluded = getExcludedCompanies();
      let excludedCount = 0;

      // All jobs with a naukri.com link — deduplicated, excluding already-skipped
      // and excluding freelance-client companies (matched by company name).
      const seenLinks = new Set();
      const targets = allJobs.filter(j => {
        if (!j.link?.includes('naukri.com')) return false;
        const key = j.link.split('?')[0];
        if (seenLinks.has(key) || skippedLinks.has(key)) return false;
        const companyName = companyMap[j.companyId] || j.companyId || '';
        if (isExcludedCompany(companyName, excluded) || isExcludedCompany(j.title, excluded)) {
          excludedCount++;
          return false;
        }
        seenLinks.add(key);
        return true;
      });

      await send(`ℹ ${skippedLinks.size} previously skipped + ${excludedCount} excluded-client jobs removed. ${targets.length} remaining to attempt.`);

      if (!targets.length) {
        await send('⚠ No Naukri jobs found. Click "Refresh All" or "Agent Scan" first, then retry.');
        await writer.close().catch(() => {});
        return;
      }

      // On the server (no display) set APPLY_HEADLESS=true so Naukri launches its
      // own headless Chrome and logs in with credentials. Locally, leave it unset
      // to attach to your visible Chrome on :9222 (or launch a visible window).
      const headless = process.env.APPLY_HEADLESS === 'true';
      ({ browser, connected } = await getBrowser({ headless, requireConnected: false }));
      const { page: workPage, reusedExisting, reason } = await getReusablePage(browser, {
        hosts: ['naukri.com'],
      });

      if (connected) {
        await send(`▶ Connected to your existing Chrome. Reusing ${reusedExisting ? reason.replace('-', ' ') : 'a new tab'} for Naukri.`);
        await send(`▶ Found ${targets.length} Naukri job(s) — no login needed.`);
      } else {
        await send(`▶ Launched browser. Found ${targets.length} unique Naukri job(s). Logging in...`);

        // Retry login up to 3 times on the same tab
        let loginSuccess = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await naukriLogin(workPage, email, password);
            await send(`✓ Logged in to Naukri`);
            loginSuccess = true;
            break;
          } catch (loginErr) {
            if (attempt < 3) {
              await send(`⚠ Login attempt ${attempt} failed: ${loginErr.message} — retrying in 3s...`);
              await new Promise(r => setTimeout(r, 3000));
            } else {
              await send(`⚠ All login attempts failed: ${loginErr.message}`);
              await send('⏳ Please log in to Naukri manually in the open browser tab. Waiting 30s...');
              await new Promise(r => setTimeout(r, 30000));
              // Check if user logged in manually
              const manuallyLoggedIn = await workPage.evaluate(() =>
                !(document.querySelector('#usernameField') || document.querySelector('#passwordField'))
              ).catch(() => false);
              if (manuallyLoggedIn) {
                loginSuccess = true;
                await send('✓ Detected manual login — continuing.');
              }
            }
          }
        }

        if (!loginSuccess) {
          await send('FATAL: Could not log in. Browser left open — log in manually and click Easy Apply again.');
          await writer.close().catch(() => {});
          return;
        }
      }

      let applied = 0;
      let failed  = 0;
      const appliedEntries = [];
      const skippedEntries = [];

      for (const job of targets) {
        const companyName = companyMap[job.companyId] || job.companyId;
        await send(`⚡ Applying: ${job.title} at ${companyName}...`);
        const result = await naukriEasyApply(workPage, job);

        if (result.success) {
          applied++;
          await send(`✓ Applied: ${job.title} at ${companyName} — ${result.reason}`);
          appliedEntries.push({
            companyId: job.companyId,
            companyName,
            jobTitle: job.title,
            jobLink: job.link,
            source: 'naukri',
          });
        } else {
          failed++;
          const linkKey = job.link.split('?')[0];
          if (result.reason === 'Already applied') {
            // Already applied — permanently skip so we don't waste time again
            skippedEntries.push({ link: linkKey, reason: 'already-applied' });
            await send(`○ Already applied: ${job.title}`);
          } else if (result.externalUrl) {
            // Found real company URL — update DB + permanently skip this naukri link
            await updateJob(job.jobId, job.companyId, {
              link: result.externalUrl,
              source: 'careers-page',
              isEasyApply: false,
            }).catch(() => {});
            skippedEntries.push({ link: linkKey, reason: 'company-website' });
            await send(`↗ Saved company URL: ${job.title} → ${result.externalUrl}`);
          } else if (result.reason === 'Apply on company website — skip') {
            skippedEntries.push({ link: linkKey, reason: 'company-website' });
            await send(`↗ Company website job: ${job.title} — link saved`);
          } else if (result.reason === 'No Apply button found') {
            skippedEntries.push({ link: linkKey, reason: 'no-apply-button' });
            await send(`✗ No Apply button: ${job.title}`);
          } else {
            await send(`✗ Skipped: ${job.title} — ${result.reason}`);
          }
        }

        // Checkpoint every 25 — save applied + skipped so crashes don't lose progress
        if ((appliedEntries.length + skippedEntries.length) % 25 === 0) {
          if (appliedEntries.length) { await recordApplied(appliedEntries).catch(() => {}); appliedEntries.length = 0; }
          if (skippedEntries.length) { await recordSkipped(skippedEntries).catch(() => {}); skippedEntries.length = 0; }
          await send(`💾 Checkpoint: ${applied} applied, ${failed} skipped so far`);
        }

        await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
      }

      if (appliedEntries.length) await recordApplied(appliedEntries);
      if (skippedEntries.length) await recordSkipped(skippedEntries);
      await send(`DONE: Applied to ${applied} jobs. ${failed} skipped/saved. Next run will skip those ${failed} automatically.`);
    } catch (e) {
      await send(`FATAL: ${e.message}`);
    } finally {
      // Only close a browser we launched ourselves — never kill user's existing Chrome
      if (browser && !connected) await browser.close().catch(() => {});
      await writer.close().catch(() => {});
    }
  })();

  return new Response(stream.readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
  });
}
