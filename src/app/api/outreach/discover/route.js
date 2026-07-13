export const maxDuration = 600;
export const dynamic = 'force-dynamic';

import { readCompanies, readOutreachContacts, addOutreachContact } from '@/lib/db';
import { isExcludedCompany, getExcludedCompanies } from '@/lib/exclusions';
import { findContactForCompany } from '@/lib/outreach-discovery';

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
  const { cap = 150 } = await request.json().catch(() => ({}));

  const encoder = new TextEncoder();
  const stream  = new TransformStream();
  const writer  = stream.writable.getWriter();
  const send    = (msg) => writer.write(encoder.encode(`data: ${JSON.stringify({ message: msg })}\n\n`));

  (async () => {
    try {
      const companies = await readCompanies();
      const existingContacts = await readOutreachContacts();
      const alreadyHaveContact = new Set(existingContacts.map(c => c.companyId).filter(Boolean));
      const excluded = getExcludedCompanies();

      const candidates = companies.filter(c =>
        !alreadyHaveContact.has(c.id) && !isExcludedCompany(c.name, excluded)
      );

      const target = Math.min(cap, candidates.length);
      await send(`ℹ ${companies.length} companies tracked, ${alreadyHaveContact.size} already have a contact. Attempting up to ${candidates.length} companies to find ${target} new contact(s)...`);

      let found = 0;
      let attempted = 0;
      const batch = candidates.slice(0, cap * 3); // allow for misses

      const chunks = [];
      for (let i = 0; i < batch.length; i += CONCURRENCY) chunks.push(batch.slice(i, i + CONCURRENCY));

      for (const chunk of chunks) {
        if (found >= cap) break;
        await mapWithConcurrency(chunk, CONCURRENCY, async (company) => {
          if (found >= cap) return;
          attempted++;
          const contact = await findContactForCompany(company);
          if (!contact) {
            await send(`○ ${company.name}: no contact found`);
            return;
          }
          const saved = await addOutreachContact({
            companyId: company.id,
            companyName: company.name,
            email: contact.email,
            source: contact.source,
            confidence: contact.confidence,
          });
          if (saved) {
            found++;
            await send(`✓ ${company.name} → ${contact.email} (${contact.confidence} confidence, via ${contact.source})`);
          }
        });
      }

      await send(`DONE: Found ${found} new contact(s) from ${attempted} companies attempted.`);
    } catch (e) {
      await send(`FATAL: ${e.message}`);
    } finally {
      await writer.close().catch(() => {});
    }
  })();

  return new Response(stream.readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
  });
}
