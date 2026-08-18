export const maxDuration = 600;
export const dynamic = 'force-dynamic';

import { readCompanies, updateCompany } from '@/lib/db';
import { detectAtsForCompany } from '@/lib/ats-detect';
import { isExcludedCompany, getExcludedCompanies } from '@/lib/exclusions';
import { startRun, finishRun, isRunning } from '@/lib/atsSweepRunState';

// Board probes are network-bound (a handful of small JSON fetches per
// company), not CPU-bound, so this can run well above the box's core count.
const CONCURRENCY = Number(process.env.ATS_SWEEP_CONCURRENCY) || 10;

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
  const { limit = Number(process.env.ATS_SWEEP_LIMIT) || 1200, recheckTagged = false } = await request.json().catch(() => ({}));

  const encoder = new TextEncoder();
  const stream  = new TransformStream();
  const writer  = stream.writable.getWriter();
  const send    = (msg) => writer.write(encoder.encode(`data: ${JSON.stringify({ message: msg })}\n\n`)).catch(() => {});

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
      // Least-recently-probed first, never-probed ahead of everything. Without
      // this ordering the slice below always cut the same prefix of a stably
      // ordered list, so the sweep spent every run re-probing companies it had
      // already answered for and never advanced into the tail.
      const TAGGED = ['greenhouse', 'lever', 'ashby', 'smartrecruiters'];
      const targets = companies
        .filter(c => !isExcludedCompany(c.name, excluded))
        .filter(c => recheckTagged || !TAGGED.includes(c.atsType) || !c.atsSlug)
        .sort((a, b) => {
          const ta = a.atsCheckedAt ? new Date(a.atsCheckedAt).getTime() : 0;
          const tb = b.atsCheckedAt ? new Date(b.atsCheckedAt).getTime() : 0;
          return ta - tb;
        })
        .slice(0, limit);

      const neverProbed = targets.filter(c => !c.atsCheckedAt).length;

      await send(`🔎 Probing ${targets.length} company(s) (${neverProbed} never probed before) for Lever / Ashby / SmartRecruiters / Greenhouse boards, least-recently-checked first...`);

      let found = 0, changed = 0, done = 0;
      const byType = { lever: 0, ashby: 0, smartrecruiters: 0, greenhouse: 0 };

      await mapWithConcurrency(targets, CONCURRENCY, async (company) => {
        if (signal.aborted) return;
        const hit = await detectAtsForCompany(company);
        done++;

        // Stamp regardless of outcome — a company with no board still has to
        // move to the back of the rotation, or the sweep re-probes the same
        // fruitless set forever, which is the bug this replaces.
        await updateCompany(company.id, { atsCheckedAt: new Date() }).catch(() => {});

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
          : `DONE: Probed ${done}. Found ${found} verified board(s) — ${byType.lever} Lever, ${byType.ashby} Ashby, ${byType.smartrecruiters} SmartRecruiters (discovery only), ${byType.greenhouse} Greenhouse. ${changed} company record(s) updated. ${appliable} are on CAPTCHA-free platforms and can actually be auto-applied to.`
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
