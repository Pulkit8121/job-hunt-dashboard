export const maxDuration = 600;
export const dynamic = 'force-dynamic';

import { getBrowser, getReusablePage } from '@/lib/browser';
import { recordApplied } from '@/lib/db';
import {
  wellfoundLogin,
  scrapeWellfoundJobCards,
  applyToWellfoundJob,
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

      ({ browser, connected } = await getBrowser({ headless: false, requireConnected: true }));
      const { page: workPage, reusedExisting, reason } = await getReusablePage(browser, {
        hosts: ['wellfound.com'],
      });

      if (connected) {
        await send(`▶ Connected to your existing Chrome. Reusing ${reusedExisting ? reason.replace('-', ' ') : 'a new tab'} for Wellfound.`);
        await send('▶ Checking Wellfound login...');
        await workPage.goto('https://wellfound.com', { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
        const isLoggedIn = await workPage.evaluate(() =>
          !document.querySelector('a[href="/login"]') || !!document.querySelector('[class*="avatar"], [class*="profile-menu"], [data-test*="user"]')
        );
        if (!isLoggedIn) {
          await send('⚠ Not logged in to Wellfound — logging in...');
          await wellfoundLogin(workPage, email, password);
          await send('✓ Logged in to Wellfound');
        } else {
          await send('✓ Already logged in to Wellfound');
        }
      } else {
        await send('▶ Launched browser. Logging in to Wellfound...');
        await wellfoundLogin(workPage, email, password);
        await send('✓ Logged in to Wellfound');
      }

      const phases = requestedPhase
        ? WF_SEARCH_PHASES.filter(p => p.id === requestedPhase)
        : WF_SEARCH_PHASES;
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
