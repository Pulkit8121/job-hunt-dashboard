export const maxDuration = 600;
export const dynamic = 'force-dynamic';

import { readCompanies, recordApplied, updateJob, recordSkipped, readActiveSkippedLinks, readNaukriApplyQueue, readAnswerCache, saveAnswer } from '@/lib/db';
import { naukriLogin, naukriEasyApply } from '@/lib/naukri';
import { getBrowser, getReusablePage, closeBrowserSafely } from '@/lib/browser';
import { isExcludedCompany, getExcludedCompanies } from '@/lib/exclusions';
import { startRun, finishRun, isRunning } from '@/lib/naukriRunState';
import { alertCaptchaBlocked } from '@/lib/captcha-alert';

export async function POST(request) {
  const email    = process.env.NAUKRI_EMAIL;
  const password = process.env.NAUKRI_PASSWORD;

  const encoder = new TextEncoder();
  const stream  = new TransformStream();
  const writer  = stream.writable.getWriter();
  const send    = (msg) => writer.write(encoder.encode(`data: ${JSON.stringify({ message: msg })}\n\n`)).catch(() => {});

  if (isRunning()) {
    await send('⚠ A Naukri apply run is already in progress. Stop it first if you want to restart.');
    await writer.close().catch(() => {});
    return new Response(stream.readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
    });
  }

  const controller = startRun();
  const signal = controller.signal;

  // A client that gives up (curl --max-time from the cron script, closed tab)
  // used to leave this loop running forever server-side — isRunning() stays
  // true with nothing able to clear it, so every later cron tick just gets
  // "already in progress" while the orphaned run holds the shared browser
  // lock indefinitely. Same fix as /api/scrape: tie the incoming request's
  // own abort signal to this run's controller.
  request.signal?.addEventListener?.('abort', () => controller.abort());

  (async () => {
    let browser;
    let connected = false;

    try {
      const companies = await readCompanies();
      const companyMap = Object.fromEntries(companies.map(c => [c.id, c.name]));

      // Links still barred from the queue. Unlike the old readSkippedLinks(),
      // this releases transient skips (no-apply-button, form errors) once
      // their cooldown has elapsed — see RETRYABLE_SKIP_REASONS in db.js.
      const skippedLinks = await readActiveSkippedLinks();

      // Freelance-client companies to never apply to
      const excluded = getExcludedCompanies();
      let excludedCount = 0;

      // Paged, skip-aware queue build. The previous version fetched only the
      // newest 500 job documents and THEN removed skipped links — with every
      // link in that window already carrying a tombstone, the target list came
      // back empty on every single run. This scans past the tombstones until
      // it has a real queue. maxAgeDays keeps the browser off listings that
      // Naukri has almost certainly already expired.
      const MAX_AGE_DAYS = Number(process.env.NAUKRI_MAX_JOB_AGE_DAYS) || 30;
      const queue = await readNaukriApplyQueue({
        limit: Number(process.env.NAUKRI_QUEUE_SIZE) || 300,
        skippedLinks,
        maxAgeDays: MAX_AGE_DAYS,
      });

      const targets = queue.filter(j => {
        const companyName = companyMap[j.companyId] || j.companyId || '';
        if (isExcludedCompany(companyName, excluded) || isExcludedCompany(j.title, excluded)) {
          excludedCount++;
          return false;
        }
        return true;
      });

      await send(`ℹ Naukri auto-apply: ${skippedLinks.size} link(s) currently barred, ${excludedCount} excluded-client job(s) dropped. ${targets.length} job(s) queued (newest first, max ${MAX_AGE_DAYS}d old).`);

      if (!targets.length) {
        await send('⚠ No Naukri jobs found. Click "Refresh All" or "Agent Scan" first, then retry.');
        await writer.close().catch(() => {});
        return;
      }

      // On the server (no display) set APPLY_HEADLESS=true so Naukri launches its
      // own headless Chrome and logs in with credentials. Locally, leave it unset
      // to attach to your visible Chrome on :9222 (or launch a visible window).
      const headless = process.env.APPLY_HEADLESS === 'true';
      ({ browser, connected } = await getBrowser({
        headless,
        requireConnected: false,
        preferConnected: !headless,
      }));
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
      let reachedQuota = false;
      let captchaBlocked = false;
      const appliedEntries = [];
      const skippedEntries = [];

      // Screening-question agent context: a shared answer cache (so a question
      // is reasoned about once, then replayed for free on later applications)
      // plus a persist hook for newly-resolved answers.
      const answerCache = await readAnswerCache().catch(() => new Map());
      let aiAnswerCount = 0;
      const agentCtx = {
        cache: answerCache,
        onResolved: async (entry) => { aiAnswerCount++; await saveAnswer(entry).catch(() => {}); },
      };
      await send(`🧠 Screening-question agent ready (${answerCache.size} cached answer(s)).`);

      for (const job of targets) {
        if (signal.aborted) {
          await send('⏹ Stopped by user.');
          break;
        }

        const companyName = companyMap[job.companyId] || job.companyId;
        await send(`⚡ Applying: ${job.title} at ${companyName}...`);
        let result = await naukriEasyApply(workPage, job, signal, agentCtx);

        // Most real failures are transient (Puppeteer navigation timeouts,
        // "Target closed" / "Execution context destroyed" — the 1-core server
        // under load, not a genuinely bad job). One immediate retry on a fresh
        // page recovers most of these instead of waiting for the next 4h cron.
        if (!result.success && !result.externalUrl && /timeout|target closed|execution context|protocol error|detached frame/i.test(result.reason || '') && !signal.aborted) {
          await send(`  ↻ Transient error (${result.reason}) — retrying once...`);
          await new Promise(r => setTimeout(r, 2000));
          result = await naukriEasyApply(workPage, job, signal, agentCtx);
        }

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
          } else if (result.expired) {
            // A genuinely terminal fact (not in RETRYABLE_SKIP_REASONS), unlike
            // the generic 'no-apply-button' this used to be misfiled as.
            skippedEntries.push({ link: linkKey, reason: 'expired' });
            await send(`⌛ Expired listing: ${job.title}`);
          } else if (result.reason === 'No Apply button found') {
            skippedEntries.push({ link: linkKey, reason: 'no-apply-button' });
            await send(`✗ No Apply button: ${job.title}`);
          } else if (result.reason === 'Screening question needs a human answer') {
            skippedEntries.push({ link: linkKey, reason: 'needs-human-answer' });
            await send(`🙋 ${job.title}: a screening question needs your answer — skipped for manual apply.`);
          } else if (result.quotaExceeded) {
            // Naukri itself has cut this account off for today — every remaining
            // job would fail identically, so stop now instead of burning the
            // whole queue against it. Not added to skippedLinks: these are real,
            // otherwise-viable jobs to retry once the quota resets.
            await send(`⛔ Naukri's daily apply quota is exhausted for this account — stopping this run. Will resume once it resets.`);
            reachedQuota = true;
          } else if (result.captchaBlocked) {
            // Every remaining job would hit the same CAPTCHA wall — stop now
            // rather than burn the queue against it. Not added to skippedLinks:
            // this job is fine, retry it once the challenge clears.
            await send(`⛔ Naukri is showing a CAPTCHA challenge — stopping this run.`);
            await alertCaptchaBlocked({ site: 'naukri.com', blockedUrl: job.link, onProgress: send });
            captchaBlocked = true;
          } else {
            // Any other failure ("Chatbot ended without a confirmation", a raw
            // exception message, etc.) used to fall through without ever being
            // added to skippedLinks — confirmed live: with the queue's first
            // job hitting one of these every time, it got retried at the FRONT
            // of the list on every single 5-minute cron cycle forever, and the
            // 240s per-cycle time cap meant the other 125+ queued jobs were
            // never even reached. Recording it here trades away a same-page
            // retry chance for guaranteed forward progress through the rest of
            // the queue, which given the alternative (permanent 0% throughput
            // past whichever job fails first) is the right tradeoff.
            skippedEntries.push({ link: linkKey, reason: 'other' });
            await send(`✗ Skipped: ${job.title} — ${result.reason}`);
          }
        }

        if (reachedQuota || captchaBlocked) break;

        // Checkpoint every 25 — save applied + skipped so crashes don't lose progress
        if ((appliedEntries.length + skippedEntries.length) % 25 === 0) {
          if (appliedEntries.length) { await recordApplied(appliedEntries).catch(() => {}); appliedEntries.length = 0; }
          if (skippedEntries.length) { await recordSkipped(skippedEntries).catch(() => {}); skippedEntries.length = 0; }
          await send(`💾 Checkpoint: ${applied} applied, ${failed} skipped so far`);
        }

        if (signal.aborted) {
          await send('⏹ Stopped by user.');
          break;
        }
        await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
      }

      if (appliedEntries.length) await recordApplied(appliedEntries);
      if (skippedEntries.length) await recordSkipped(skippedEntries);
      if (signal.aborted) {
        await send(`STOPPED: Applied to ${applied} jobs before stopping. ${failed} skipped/saved.`);
      } else if (reachedQuota) {
        await send(`DONE: Applied to ${applied} jobs before hitting Naukri's daily quota. ${failed} skipped/saved this run.`);
      } else if (captchaBlocked) {
        await send(`DONE: Applied to ${applied} jobs before hitting a CAPTCHA challenge. ${failed} skipped/saved this run.`);
      } else {
        await send(`DONE: Applied to ${applied} jobs. ${failed} skipped/saved. ${aiAnswerCount} new screening answer(s) learned and cached. Next run will skip those ${failed} automatically.`);
      }
    } catch (e) {
      await send(`FATAL: ${e.message}`);
    } finally {
      // Only close a browser we launched ourselves — never kill user's existing Chrome
      await closeBrowserSafely(browser, connected);
      finishRun();
      await writer.close().catch(() => {});
    }
  })();

  return new Response(stream.readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
  });
}
