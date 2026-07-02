export const maxDuration = 600;
export const dynamic = 'force-dynamic';

import { getBrowser, getReusablePage } from '@/lib/browser';
import { recordApplied } from '@/lib/db';
import { isExcludedCompany, getExcludedCompanies } from '@/lib/exclusions';
import {
  wellfoundLogin,
  scrapeWellfoundJobCards,
  applyToWellfoundJob,
  setupWellfoundProfile,
  WF_SEARCH_PHASES,
  WF_PROFILE,
} from '@/lib/wellfound';

export async function POST(request) {
  const { phase: requestedPhase } = await request.json().catch(() => ({}));

  const encoder = new TextEncoder();
  const stream  = new TransformStream();
  const writer  = stream.writable.getWriter();
  const send    = (msg) => writer.write(encoder.encode(`data: ${JSON.stringify({ message: msg })}\n\n`));

  (async () => {
    let browser;
    let connected = false;

    try {
      const email    = process.env.WELLFOUND_EMAIL || WF_PROFILE.email;
      const password = process.env.WELLFOUND_PASSWORD;

      if (!email || !password) {
        throw new Error('Missing WELLFOUND_EMAIL or WELLFOUND_PASSWORD in environment');
      }

      // Wellfound is protected by Cloudflare/DataDome, which hard-blocks datacenter
      // IPs — automated login from the server just gets the challenge page. The
      // workaround: a headful Chrome runs on the server's virtual display (started
      // by /usr/local/bin/wf-browser.sh, viewable over the password-protected noVNC
      // screen). You clear Cloudflare + sign in there ONCE, and the bot attaches to
      // that same authenticated session over the local DevTools port (9222).
      const onServer = process.env.APPLY_HEADLESS === 'true';

      try {
        // On the server, require the VNC Chrome on :9222. Locally, attach to your
        // Chrome on :9222 if present, otherwise launch a visible window.
        ({ browser, connected } = await getBrowser({ headless: false, requireConnected: onServer }));
      } catch (e) {
        if (onServer) {
          await send('⛔ No Wellfound browser session found on the server.');
          await send('▶ Start it: SSH in and run `/usr/local/bin/wf-browser.sh`');
          await send('▶ Then open the noVNC screen (http://187.127.188.153:6080/vnc.html), sign into Wellfound (clear the Cloudflare check), and click Apply again.');
          await send('DONE: Waiting for the VNC browser + your Wellfound login.');
          await writer.close().catch(() => {});
          return;
        }
        throw e;
      }

      const { page: workPage, reusedExisting, reason } = await getReusablePage(browser, {
        hosts: ['wellfound.com'],
      });

      // Verify we're actually logged in (you sign in manually via noVNC on the
      // server; locally the bot can log in itself since your home IP isn't blocked).
      await workPage.goto('https://wellfound.com', { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
      const loginState = await workPage.evaluate(() => {
        const onChallenge = /just a moment|attention required|verify you are human/i.test(document.title + ' ' + (document.body?.innerText || '').slice(0, 200));
        const loggedIn = !document.querySelector('a[href="/login"]') || !!document.querySelector('[class*="avatar"], [class*="profile-menu"], [data-test*="user"]');
        return { onChallenge, loggedIn };
      });

      if (loginState.onChallenge) {
        await send('⚠ Cloudflare challenge is showing in the server browser.');
        await send('▶ Open http://187.127.188.153:6080/vnc.html, solve the check, sign into Wellfound, then click Apply again.');
        await send('DONE: Waiting for you to clear Cloudflare + log in via noVNC.');
        await writer.close().catch(() => {});
        return;
      }

      if (loginState.loggedIn) {
        await send(`✓ Using logged-in Wellfound session${connected ? ` (attached to ${reusedExisting ? reason.replace('-', ' ') : 'the VNC browser'})` : ''}.`);
      } else if (onServer) {
        await send('⚠ Not logged into Wellfound in the server browser.');
        await send('▶ Open http://187.127.188.153:6080/vnc.html, sign in, then click Apply again.');
        await send('DONE: Waiting for your Wellfound login via noVNC.');
        await writer.close().catch(() => {});
        return;
      } else {
        await send('▶ Not logged in — logging in locally...');
        await wellfoundLogin(workPage, email, password);
        await send('✓ Logged in to Wellfound');
      }

      // One-time profile setup — LinkedIn/GitHub/portfolio and work-authorization
      // preferences live on Wellfound's profile pages, not in the per-job apply
      // modal, so this only needs to run once per session.
      await send('▶ Checking Wellfound profile (LinkedIn/GitHub/work authorization)...');
      await setupWellfoundProfile(workPage, (msg) => send(msg));

      const phases = requestedPhase
        ? WF_SEARCH_PHASES.filter(p => p.id === requestedPhase)
        : WF_SEARCH_PHASES;
      const excluded = getExcludedCompanies();
      let totalApplied = 0;
      let totalFailed  = 0;
      const appliedEntries = [];

      for (const phase of phases) {
        await send(`\n── Phase: ${phase.label} ──`);

        // Scrape job cards from all search URLs in this phase
        const seenUrls  = new Set();
        const allJobs   = [];

        for (const url of phase.urls) {
          await send(`🔍 Scanning: ${url}`);
          const cards = await scrapeWellfoundJobCards(workPage, url);
          await send(`  Found ${cards.length} job cards`);
          for (const card of cards) {
            const key = (card.applyUrl || card.cardUrl || '').split('?')[0];
            if (!key || seenUrls.has(key)) continue;
            // Skip freelance-client companies (Drytis / Dofin) — don't reveal
            // current employer to a company Pulkit already works with.
            if (isExcludedCompany(card.company, excluded) || isExcludedCompany(card.title, excluded)) {
              seenUrls.add(key);
              await send(`  ⊘ Skipping excluded client: ${card.company || card.title}`);
              continue;
            }
            seenUrls.add(key);
            allJobs.push({ ...card, phase: phase.id });
          }
        }
        await send(`ℹ ${allJobs.length} unique jobs found in this phase`);

        if (!allJobs.length) {
          await send('  No jobs found for this phase — moving on');
          continue;
        }

        // Apply to each job
        for (const job of allJobs) {
          const label = `${job.title || 'Unknown Role'} at ${job.company || 'Unknown'}`;
          await send(`⚡ Applying: ${label}...`);

          const result = await applyToWellfoundJob(
            workPage,
            job,
            (msg) => send(msg)
          );

          if (result.success) {
            totalApplied++;
            await send(`✓ Applied: ${label}`);
            appliedEntries.push({
              companyId:   (job.company || 'wellfound').toLowerCase().replace(/\s+/g, '-'),
              companyName: job.company || 'Unknown',
              jobTitle:    job.title   || 'Unknown Role',
              jobLink:     job.applyUrl || job.cardUrl || '',
              source:      'wellfound',
            });
          } else {
            totalFailed++;
            if (result.reason === 'Already applied') {
              await send(`○ Already applied: ${label}`);
            } else {
              await send(`✗ Skipped: ${label} — ${result.reason}`);
            }
          }

          // Checkpoint every 10
          if (appliedEntries.length % 10 === 0 && appliedEntries.length > 0) {
            await recordApplied(appliedEntries).catch(() => {});
            await send(`💾 Checkpoint: ${totalApplied} applied so far`);
          }

          await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000));
        }
      }

      // Final save
      if (appliedEntries.length > 0) await recordApplied(appliedEntries).catch(() => {});

      await send(`DONE: Applied to ${totalApplied} Wellfound jobs. ${totalFailed} skipped.`);
    } catch (e) {
      await send(`FATAL: ${e.message}`);
    } finally {
      if (browser && !connected) await browser.close().catch(() => {});
      await writer.close().catch(() => {});
    }
  })();

  return new Response(stream.readable, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    },
  });
}
