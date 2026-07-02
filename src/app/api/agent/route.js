export const maxDuration = 600;
export const dynamic = 'force-dynamic';

import { readCompanies, replaceJobsForCompany, updateCompanyScraped } from '@/lib/db';
import { scrapeCompanyWithAgent } from '@/lib/agent-scraper';
import { cacheDel, cacheSet } from '@/lib/cache';

export async function POST(request) {
  const { companyId } = await request.json().catch(() => ({ companyId: 'all' }));
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

      const all = await readCompanies();
      const targets = companyId === 'all' ? all : all.filter(company => company.id === companyId);

      if (!targets.length) {
        send('No matching companies found.');
        return;
      }

      send(`🤖 Starting agent scan of ${targets.length} ${targets.length === 1 ? 'company' : 'companies'}...`);

      let totalFound = 0;

      for (const company of targets) {
        try {
          const jobs = await scrapeCompanyWithAgent(company, browser, send);
          await replaceJobsForCompany(company.id, jobs);
          await updateCompanyScraped(company.id);

          const cacheKey = `jobs:${company.id}`;
          if (jobs.length > 0) {
            await cacheSet(cacheKey, jobs);
          } else {
            await cacheDel(cacheKey);
          }

          totalFound += jobs.length;
        } catch (e) {
          send(`✗ Agent error for ${company.name}: ${e.message}`);
        }
      }

      send(`DONE:${totalFound} jobs found across ${targets.length} companies via agent scan.`);
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
