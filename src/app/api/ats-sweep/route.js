export const maxDuration = 600;
export const dynamic = 'force-dynamic';

import { readCompanies, updateCompany } from '@/lib/db';
import { detectAtsForCompany } from '@/lib/ats-detect';
import { isExcludedCompany, getExcludedCompanies } from '@/lib/exclusions';
import { startRun, finishRun, isRunning } from '@/lib/atsSweepRunState';

const CONCURRENCY = 4;

async function mapWithConcurrency(items, limit, fn) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i).catch(() => {});
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function POST(request) {
  const { limit = 400, recheckTagged = false } = await request.json().catch(() => ({}));

  const encoder = new TextEncoder();
  const stream  = new TransformStream();
  const writer  = stream.writable.getWriter();
  const send    = (msg) => writer.write(encoder.encode(`data: ${JSON.stringify({ message: msg })}\n\n`));

  if (isRunning()) {
    await send('⚠ An ATS sweep is already running. Skipping this trigger.');
    await writer.close().catch(() => {});
    return new Response(stream.readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
    });
  }

  const controller = startRun();
  const signal = controller.signal;

  (async () => {
    try {
      const companies = await readCompanies();
      const excluded = getExcludedCompanies();

      // By default only look at companies we haven't identified yet. With
      // recheckTagged, also re-verify existing tags — worth doing once, since
      // seed data had Meesho and Nium on Greenhouse when they're really on
      // Lever, and Porter pointing at an unrelated company's board entirely.
      const targets = companies
        .filter(c => !isExcludedCompany(c.name, excluded))
        .filter(c => recheckTagged || !['greenhouse', 'lever', 'ashby'].includes(c.atsType) || !c.atsSlug)
        .slice(0, limit);

      await send(`🔎 Probing ${targets.length} company(s) for Lever / Ashby / Greenhouse boards (Lever+Ashby first — those are the ones without a CAPTCHA wall)...`);

      let found = 0, changed = 0, done = 0;
      const byType = { lever: 0, ashby: 0, greenhouse: 0 };

      await mapWithConcurrency(targets, CONCURRENCY, async (company) => {
        if (signal.aborted) return;
        const hit = await detectAtsForCompany(company);
        done++;

        if (done % 25 === 0) await send(`… ${done}/${targets.length} probed, ${found} board(s) found`);
        if (!hit) return;

        found++;
        byType[hit.atsType] = (byType[hit.atsType] || 0) + 1;

        const isChange = company.atsType !== hit.atsType || company.atsSlug !== hit.atsSlug;
        if (isChange) {
          await updateCompany(company.id, { atsType: hit.atsType, atsSlug: hit.atsSlug }).catch(() => {});
          changed++;
          const was = company.atsSlug ? `${company.atsType}/${company.atsSlug}` : 'untagged';
          await send(`✓ ${company.name}: ${was} → ${hit.atsType}/${hit.atsSlug} (${hit.jobCount} on board, ${hit.relevantCount} relevant)`);
        }
      });

      const appliable = byType.lever + byType.ashby;
      await send(
        signal.aborted
          ? `STOPPED: ${found} board(s) found, ${changed} updated before stopping.`
          : `DONE: Probed ${done}. Found ${found} verified board(s) — ${byType.lever} Lever, ${byType.ashby} Ashby, ${byType.greenhouse} Greenhouse. ${changed} company record(s) updated. ${appliable} are on CAPTCHA-free platforms and can actually be auto-applied to.`
      );
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
