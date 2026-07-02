export const maxDuration = 300;
export const dynamic = 'force-dynamic';

import { readCompanies, replaceJobsForCompany, updateCompanyScraped } from '@/lib/db';
import { scrapeCompany } from '@/lib/scraper';
import { cacheGet, cacheSet, cacheDel } from '@/lib/cache';

export async function POST(request) {
  const { companyId, bust } = await request.json();
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
      const targets = companyId === 'all' ? all : all.filter(c => c.id === companyId);

      if (!targets.length) { send('No matching companies found.'); return; }

      send(`Starting scan of ${targets.length} ${targets.length === 1 ? 'company' : 'companies'}...`);

      let totalFound = 0;

      for (const company of targets) {
        try {
          const cacheKey = `jobs:${company.id}`;

          // Use cache unless caller explicitly busted it
          if (!bust) {
            const cached = await cacheGet(cacheKey);
            if (Array.isArray(cached) && cached.length > 0) {
              send(`⚡ ${company.name}: ${cached.length} jobs from cache`);
              await replaceJobsForCompany(company.id, cached);
              await updateCompanyScraped(company.id);
              totalFound += cached.length;
              continue;
            }
            if (Array.isArray(cached) && cached.length === 0) {
              send(`ℹ ${company.name}: cached empty result ignored, trying live scan`);
              await cacheDel(cacheKey);
            }
          } else {
            await cacheDel(cacheKey);
          }

          const jobs = await scrapeCompany(company, browser, send);
          await replaceJobsForCompany(company.id, jobs);
          await updateCompanyScraped(company.id);
          if (jobs.length > 0) {
            await cacheSet(cacheKey, jobs); // cache for 2h
          }
          totalFound += jobs.length;
        } catch (e) {
          send(`✗ Error scraping ${company.name}: ${e.message}`);
        }
      }

      send(`DONE:${totalFound} jobs found across ${targets.length} companies.`);
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
