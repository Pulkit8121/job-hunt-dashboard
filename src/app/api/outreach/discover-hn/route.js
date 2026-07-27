export const maxDuration = 600;
export const dynamic = 'force-dynamic';

import { readOutreachEmails, addOutreachContact } from '@/lib/db';
import { isExcludedCompany, getExcludedCompanies, isExcludedOutreachCompany, isExcludedOutreachDomain } from '@/lib/exclusions';
import { scrapeLatestWhoIsHiringThread } from '@/lib/hn-hiring-scraper';
import { scrapeDirectories } from '@/lib/email-enrichment';
import { startRun, finishRun, isRunning } from '@/lib/hnDiscoverRunState';

export async function POST() {
  const encoder = new TextEncoder();
  const stream  = new TransformStream();
  const writer  = stream.writable.getWriter();
  const send    = (msg) => writer.write(encoder.encode(`data: ${JSON.stringify({ message: msg })}\n\n`)).catch(() => {});

  if (isRunning()) {
    await send('⚠ An HN discovery run is already in progress. Skipping this trigger.');
    await writer.close().catch(() => {});
    return new Response(stream.readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
    });
  }
  startRun();

  (async () => {
    try {
      const existingEmails = await readOutreachEmails();
      const excluded = getExcludedCompanies();

      await send('ℹ Fetching latest HN "Who is hiring?" thread...');
      const { threadTitle, contacts } = await scrapeLatestWhoIsHiringThread();
      if (!threadTitle) {
        await send('DONE: Could not find a "Who is hiring?" thread.');
        return;
      }
      await send(`ℹ Found "${threadTitle}" with ${contacts.length} candidate contact(s). Filtering and saving...`);

      let found = 0;
      for (const contact of contacts) {
        if (existingEmails.has(contact.email.toLowerCase())) continue;
        if (isExcludedCompany(contact.companyName, excluded)) continue;
        if (isExcludedOutreachCompany(contact.companyName)) continue;
        if (isExcludedOutreachDomain(contact.email)) continue;

        const saved = await addOutreachContact({
          companyName: contact.companyName,
          email: contact.email,
          source: 'hn-hiring',
          confidence: 'medium',
        });
        if (saved) {
          found++;
          await send(`✓ ${contact.companyName} → ${contact.email}`);
        }
      }

      // Second source: startup/agency directories. Runs only if DIRECTORY_PAGES
      // is populated — Seedtable/Clutch now block automated access, so by
      // default this is a no-op rather than a wasted request per run.
      let dirFound = 0;
      const dirContacts = await scrapeDirectories({ onProgress: send }).catch(() => []);
      for (const c of dirContacts) {
        if (existingEmails.has(c.email.toLowerCase())) continue;
        if (isExcludedCompany(c.companyName, excluded)) continue;
        if (isExcludedOutreachCompany(c.companyName)) continue;
        if (isExcludedOutreachDomain(c.email)) continue;

        const saved = await addOutreachContact({
          companyName: c.companyName,
          email: c.email,
          source: c.source,
          confidence: 'low', // directory-scraped, not verified as an HR mailbox
        });
        if (saved) {
          dirFound++;
          existingEmails.add(c.email.toLowerCase());
          await send(`✓ ${c.companyName} → ${c.email}`);
        }
      }

      await send(`DONE: Found ${found} new contact(s) from "${threadTitle}"${dirFound ? ` + ${dirFound} from directories` : ''}.`);
    } catch (e) {
      await send(`FATAL: ${e.message}`);
    } finally {
      finishRun();
      await writer.close().catch(() => {});
    }
  })();

  return new Response(stream.readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
  });
}
