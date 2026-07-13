export const maxDuration = 300;
export const dynamic = 'force-dynamic';

import { readCompanies, savePeople } from '@/lib/db';
import { getLinkedInPeopleTargets } from '@/lib/linkedin';
import { linkedInLogin, scrapeLinkedInPeople } from '@/lib/linkedin-scraper';
import { getBrowser } from '@/lib/browser';
import { startRun, finishRun, isRunning } from '@/lib/linkedinRunState';

export async function POST(request) {
  const { companyId, headless } = await request.json().catch(() => ({}));
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

      const companies = await readCompanies();
      const targets = companyId === 'all' || !companyId
        ? companies
        : companies.filter(c => c.id === companyId);

      if (!targets.length) {
        await send('⚠ No companies to scrape LinkedIn people for.');
        await writer.close();
        return;
      }

      if (connected) {
        await send('▶ Connected to your existing Chrome (already logged in to LinkedIn).');
      } else {
        if (!email || !password) {
          await send('FATAL: Set LINKEDIN_EMAIL and LINKEDIN_PASSWORD in .env.local (or use existing Chrome to skip login).');
          return;
        }
        await send('▶ Logging in to LinkedIn...');
        const loginPage = await browser.newPage();
        try {
          await linkedInLogin(loginPage, email, password);
          await send('✓ LinkedIn login successful');
        } finally {
          await loginPage.close().catch(() => {});
        }
      }

      const page = await browser.newPage();
      let totalFound = 0;

      for (const company of targets) {
        if (signal.aborted) {
          await send('⏹ LinkedIn scrape stopped.');
          break;
        }

        const searchTargets = getLinkedInPeopleTargets(company);
        const priority = searchTargets.filter(t =>
          ['talent-acquisition', 'engineering-managers', 'senior-engineers'].includes(t.id)
        );

        await send(`🔍 Scraping LinkedIn people for ${company.name}...`);
        const people = [];

        for (const target of priority) {
          if (signal.aborted) break;
          try {
            const results = await scrapeLinkedInPeople(page, target.url, (msg) => send(msg));
            for (const person of results) {
              people.push({
                companyId: company.id,
                name: person.name,
                title: person.title,
                profileUrl: person.profileUrl,
                searchType: target.id,
                message: target.message,
                connected: false,
                scrapedAt: new Date().toISOString(),
              });
            }
            await send(`✓ ${company.name} / ${target.label}: found ${results.length} people`);
          } catch (e) {
            await send(`⚠ ${company.name} / ${target.label}: ${e.message}`);
          }
          await new Promise(r => setTimeout(r, 2000 + Math.random() * 1500));
        }

        if (people.length > 0) {
          await savePeople(people);
          totalFound += people.length;
          await send(`✓ Saved ${people.length} people for ${company.name}`);
        } else {
          await send(`○ ${company.name}: no people found`);
        }

        await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
      }

      await send(`DONE: Scraped ${totalFound} LinkedIn profiles across ${targets.length} companies.`);
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
