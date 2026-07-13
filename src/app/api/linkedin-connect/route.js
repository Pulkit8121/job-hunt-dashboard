export const maxDuration = 600;
export const dynamic = 'force-dynamic';

import { readPeople, markPersonConnected } from '@/lib/db';
import { linkedInLogin, sendConnectionRequest } from '@/lib/linkedin-scraper';
import { getBrowser } from '@/lib/browser';
import { startRun, finishRun, isRunning } from '@/lib/linkedinRunState';

export async function POST(request) {
  const { companyId, limit = 20, headless } = await request.json().catch(() => ({}));
  const email    = process.env.LINKEDIN_EMAIL;
  const password = process.env.LINKEDIN_PASSWORD;

  const encoder = new TextEncoder();
  const stream  = new TransformStream();
  const writer  = stream.writable.getWriter();
  const send    = (msg) => writer.write(encoder.encode(`data: ${JSON.stringify({ message: msg })}\n\n`));

  if (isRunning()) {
    await send('⚠ A LinkedIn automation run is already in progress. Wait for it to finish before starting another.');
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
        headless: typeof headless === 'boolean'
          ? headless
          : process.env.LINKEDIN_HEADLESS === 'true',
      }));

      const allPeople = await readPeople(companyId || null);
      const pending = allPeople.filter(p => !p.connected && p.profileUrl).slice(0, limit);

      if (!pending.length) {
        await send('⚠ No pending connection targets. Run "Scrape People" first.');
        await writer.close();
        return;
      }

      if (connected) {
        await send(`▶ Connected to your existing Chrome. Sending ${pending.length} connection requests...`);
      } else {
        if (!email || !password) {
          await send('FATAL: Set LINKEDIN_EMAIL and LINKEDIN_PASSWORD in .env.local (or use existing Chrome to skip login).');
          return;
        }
        await send(`▶ Sending connections to ${pending.length} people. Logging in to LinkedIn...`);
        const loginPage = await browser.newPage();
        try {
          await linkedInLogin(loginPage, email, password);
          await send('✓ LinkedIn login successful');
        } finally {
          await loginPage.close().catch(() => {});
        }
      }

      const page = await browser.newPage();
      let sent = 0;
      let failed = 0;

      for (const person of pending) {
        if (signal.aborted) {
          await send('⏹ LinkedIn connect stopped.');
          break;
        }

        await send(`📤 Connecting with ${person.name} (${person.title || 'no title'})...`);
        const result = await sendConnectionRequest(page, person.profileUrl, person.message || '');

        if (result.success) {
          sent++;
          await markPersonConnected(person.profileUrl);
          await send(`✓ Sent to ${person.name} — ${result.reason}`);
        } else {
          failed++;
          await send(`✗ Skipped ${person.name} — ${result.reason}`);
        }

        await new Promise(r => setTimeout(r, 5000 + Math.random() * 7000));
      }

      await send(`DONE: Sent ${sent} connection requests. ${failed} skipped.`);
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
