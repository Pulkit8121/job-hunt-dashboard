export const maxDuration = 600;
export const dynamic = 'force-dynamic';

import { readOutreachEmails, addOutreachContact, readCompanies, addCompany } from '@/lib/db';
import { isExcludedCompany, getExcludedCompanies, isExcludedOutreachCompany, isExcludedOutreachDomain } from '@/lib/exclusions';
import { scrapeRecentWhoIsHiringThreads } from '@/lib/hn-hiring-scraper';
import { scrapeDirectories } from '@/lib/email-enrichment';
import { slugifyCompanyId, buildCompanyRecord } from '@/lib/company-utils';
import { startRun, finishRun, isRunning } from '@/lib/hnDiscoverRunState';

const MONTHS_BACK = Number(process.env.HN_MONTHS_BACK) || 6;

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
      const existingCompanies = await readCompanies();
      const companyIds = new Set(existingCompanies.map(c => c.id));

      await send(`ℹ Fetching the last ${MONTHS_BACK} HN "Who is hiring?" threads...`);
      const { threads, contacts } = await scrapeRecentWhoIsHiringThreads(MONTHS_BACK);
      if (!threads?.length) {
        await send('DONE: Could not find any "Who is hiring?" threads.');
        return;
      }
      await send(`ℹ Scanned ${threads.length} thread(s): ${threads.join(', ')}. ${contacts.length} candidate contact(s) found. Filtering and saving...`);

      let found = 0;
      const regionCounts = { us: 0, europe: 0, remote: 0, other: 0 };
      for (const contact of contacts) {
        if (existingEmails.has(contact.email.toLowerCase())) continue;
        if (isExcludedCompany(contact.companyName, excluded)) continue;
        if (isExcludedOutreachCompany(contact.companyName)) continue;
        if (isExcludedOutreachDomain(contact.email)) continue;

        const companyId = slugifyCompanyId(contact.companyName);
        if (companyId && !companyIds.has(companyId)) {
          const company = buildCompanyRecord({
            name: contact.companyName,
            locations: contact.location ? [contact.location] : ['Remote'],
            autoDiscovered: true,
          });
          await addCompany(company).catch(() => {});
          companyIds.add(companyId);
        }

        const saved = await addOutreachContact({
          companyId: companyId || undefined,
          companyName: contact.companyName,
          email: contact.email,
          source: 'hn-hiring',
          confidence: 'medium',
        });
        if (saved) {
          found++;
          regionCounts[contact.region || 'other']++;
          await send(`✓ [${(contact.region || 'other').toUpperCase()}] ${contact.companyName} (${contact.location || 'unknown location'}) → ${contact.email}`);
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

      await send(`DONE: Found ${found} new contact(s) across ${threads.length} thread(s) (US: ${regionCounts.us}, Europe: ${regionCounts.europe}, Remote: ${regionCounts.remote}, Other: ${regionCounts.other})${dirFound ? ` + ${dirFound} from directories` : ''}.`);
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
