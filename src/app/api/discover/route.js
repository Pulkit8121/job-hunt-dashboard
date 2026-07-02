export const maxDuration = 240;
export const dynamic = 'force-dynamic';

import { discoverCompanies } from '@/lib/discover';

export async function POST() {
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const send = (msg) => writer.write(encoder.encode(`data: ${JSON.stringify({ message: msg })}\n\n`));

  (async () => {
    let browser;
    try {
      const puppeteer = (await import('puppeteer')).default;
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
      const count = await discoverCompanies(browser, send);
      send(`DONE:${count} new companies added.`);
    } catch (e) {
      send(`FATAL:${e.message}`);
    } finally {
      try { await browser?.close(); } catch {}
      writer.close();
    }
  })();

  return new Response(stream.readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}
