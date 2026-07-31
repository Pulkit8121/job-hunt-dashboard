export const maxDuration = 600;
export const dynamic = 'force-dynamic';

import { readCompanies, readOutreachEmails, addOutreachContact, addCompany } from '@/lib/db';
import { isExcludedCompany, getExcludedCompanies, isExcludedOutreachCompany, isExcludedOutreachDomain } from '@/lib/exclusions';
import { fetchYcCompanies } from '@/lib/email-sources/yc-companies';
import { findContactForCompany } from '@/lib/outreach-discovery';
import { slugifyCompanyId, buildCompanyRecord } from '@/lib/company-utils';
import { startRun, finishRun, isRunning } from '@/lib/discoverRunState';

const CONCURRENCY = 5;

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i).catch(() => null);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function POST(request) {
  const { cap = 150, onlyHiring = true } = await request.json().catch(() => ({}));

  const encoder = new TextEncoder();
  const stream  = new TransformStream();
  const writer  = stream.writable.getWriter();
  const send    = (msg) => writer.write(encoder.encode(`data: ${JSON.stringify({ message: msg })}\n\n`)).catch(() => {});

  if (isRunning()) {
    await send('⚠ A contact-discovery run is already in progress. Skipping this trigger.');
    await writer.close().catch(() => {});
    return new Response(stream.readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
    });
  }
  startRun();

  (async () => {
    try {
      await send('ℹ Fetching Y Combinator public company directory...');
      const ycCompanies = await fetchYcCompanies({ onlyHiring });

      const existingCompanies = await readCompanies();
      const existingIds = new Set(existingCompanies.map(c => c.id));
      const existingEmails = await readOutreachEmails();
      const excluded = getExcludedCompanies();

      const candidates = ycCompanies.filter(c =>
        !existingIds.has(slugifyCompanyId(c.name)) && // skip companies already attempted in a prior run
        !isExcludedCompany(c.name, excluded) &&
        !isExcludedOutreachCompany(c.name) &&
        !isExcludedOutreachDomain(c.website)
      );

      await send(`ℹ ${ycCompanies.length} active${onlyHiring ? ' + hiring' : ''} YC companies, ${candidates.length} not yet attempted. Attempting up to ${Math.min(cap, candidates.length)}...`);

      const batch = candidates.slice(0, cap);
      const chunks = [];
      for (let i = 0; i < batch.length; i += CONCURRENCY) chunks.push(batch.slice(i, i + CONCURRENCY));

      let found = 0;
      let newCompanies = 0;
      const regionCounts = { us: 0, europe: 0, india: 0, remote: 0, other: 0 };

      for (const chunk of chunks) {
        await mapWithConcurrency(chunk, CONCURRENCY, async (yc) => {
          const companyId = slugifyCompanyId(yc.name);
          if (companyId && !existingIds.has(companyId)) {
            const company = buildCompanyRecord({
              name: yc.name,
              careersUrl: yc.website,
              locations: [yc.location],
              autoDiscovered: true,
            });
            await addCompany(company).catch(() => {});
            existingIds.add(companyId);
            newCompanies++;
          }

          const contact = await findContactForCompany({ name: yc.name, careersUrl: yc.website });
          if (!contact) {
            await send(`○ ${yc.name}: no contact found`);
            return;
          }
          if (existingEmails.has(contact.email.toLowerCase()) || isExcludedOutreachDomain(contact.email)) return;

          const saved = await addOutreachContact({
            companyId,
            companyName: yc.name,
            email: contact.email,
            source: 'yc',
            confidence: contact.confidence,
          });
          if (saved) {
            found++;
            existingEmails.add(contact.email.toLowerCase());
            regionCounts[yc.region]++;
            await send(`✓ [${yc.region.toUpperCase()}] ${yc.name} (${yc.batch || 'YC'}) → ${contact.email} (${contact.confidence})`);
          }
        });
      }

      await send(`DONE: Found ${found} new contact(s) + tracked ${newCompanies} new companies from ${batch.length} YC companies attempted (US: ${regionCounts.us}, Europe: ${regionCounts.europe}, India: ${regionCounts.india}, Remote: ${regionCounts.remote}, Other: ${regionCounts.other}).`);
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
