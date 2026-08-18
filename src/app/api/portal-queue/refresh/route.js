export const maxDuration = 900;
export const dynamic = 'force-dynamic';

import { readLiveBoards, readCompanies, readApplied, readActiveSkippedLinks, upsertPortalJobs, portalQueueStats, releaseStalePortalJobs } from '@/lib/db';
import { discoverAtsJobs } from '@/lib/company-portal-discovery';
import { isExcludedCompany, getExcludedCompanies } from '@/lib/exclusions';
import { startRun, finishRun, isRunning } from '@/lib/portalQueueRunState';

const AUTO_SUBMIT_ATS = ['greenhouse', 'lever', 'ashby', 'workable', 'recruitee', 'breezy', 'teamtailor'];
const DISCOVER_CONCURRENCY = Number(process.env.PORTAL_DISCOVER_CONCURRENCY) || 12;

async function mapWithConcurrency(items, limit, fn) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i).catch(() => {});
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

// Fills the company-portal apply queue.
//
// This is the slow half of the split that makes continuous applying possible.
// Sweeping every live board costs ~52ms per board across 13,385 boards — 11.6
// minutes — which is fine on a 4-hourly cadence but was ruinous when the apply
// route paid it on every tick before submitting anything.
//
// readLiveBoards interleaves platforms round-robin while keeping each
// platform's own oldest-first rotation, so a run capped by `boardLimit` covers
// every platform proportionally instead of exhausting the oldest one first.
export async function POST(request) {
  const {
    // Bounded by default. Found the production queue completely drained (0
    // pending) while applies were still running, i.e. the drainer worked but
    // the refill never completed — an unbounded sweep of all 13,385 boards
    // takes ~11.6 minutes and the SSE client gives up first, so nothing was
    // ever committed. 4,000 boards measured at 4.6 minutes and yielded 2,959
    // queued jobs, which is many ticks' worth. Because readLiveBoards
    // interleaves platforms and orders by probe age, successive capped runs
    // still rotate across the whole set.
    boardLimit = Number(process.env.QUEUE_REFRESH_BOARD_LIMIT) || 4000,
  } = await request.json().catch(() => ({}));

  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const send = (m) => writer.write(encoder.encode(`data: ${JSON.stringify({ message: m })}\n\n`)).catch(() => {});

  // A full sweep takes ~11.6 minutes but the apply tick runs every 10, so
  // without this two sweeps overlap — doubling load on every ATS API and on a
  // box that is simultaneously running a dozen Chrome tabs.
  if (isRunning()) {
    await send('⚠ A queue refresh is already running. Skipping this trigger.');
    await writer.close().catch(() => {});
    return new Response(stream.readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
    });
  }
  const controller = startRun();
  const signal = controller.signal;
  request.signal?.addEventListener?.('abort', () => controller.abort());

  (async () => {
    try {
      const released = await releaseStalePortalJobs({ olderThanMinutes: 30 });
      if (released) await send(`↻ Returned ${released} stalled in-progress job(s) to pending.`);

      const boards = (await readLiveBoards({ atsTypes: AUTO_SUBMIT_ATS })).slice(0, boardLimit);
      const companies = await readCompanies();
      const excluded = getExcludedCompanies();
      const nameBySlug = new Map(
        companies.filter(c => c.atsSlug).map(c => [`${c.atsType}/${c.atsSlug}`, { id: c.id, name: c.name }])
      );

      // Postings already dealt with must not re-enter the queue. upsertPortalJobs
      // won't resurrect a row it already has, but a posting applied to before
      // this collection existed has no row at all — hence checking both.
      const applied = new Set((await readApplied()).map(a => (a.jobLink || '').split('?')[0]));
      const skipped = await readActiveSkippedLinks();

      await send(`🔎 Sweeping ${boards.length} live board(s) at ${DISCOVER_CONCURRENCY}-way...`);

      let found = 0, queued = 0, done = 0;
      const batch = [];
      const flush = async () => {
        if (!batch.length) return;
        const { inserted } = await upsertPortalJobs(batch.splice(0));
        queued += inserted;
      };

      await mapWithConcurrency(boards, DISCOVER_CONCURRENCY, async (b) => {
        if (signal.aborted) return;
        const known = nameBySlug.get(`${b.atsType}/${b.slug}`);
        const companyName = known?.name || b.name || b.slug;
        if (isExcludedCompany(companyName, excluded)) return;

        let jobs = [];
        try {
          jobs = await discoverAtsJobs({ atsType: b.atsType, atsSlug: b.slug, name: companyName });
        } catch { return; }

        for (const j of jobs) {
          const link = (j.link || '').split('?')[0];
          if (!link || applied.has(link) || skipped.has(link)) continue;
          found++;
          batch.push({
            link,
            atsType: b.atsType,
            atsSlug: b.slug,
            companyId: known?.id || `${b.atsType}-${b.slug}`,
            companyName,
            title: j.title,
            location: j.location,
          });
        }

        if (batch.length >= 500) await flush();
        if (++done % 1000 === 0) await send(`… ${done}/${boards.length} boards, ${queued} newly queued`);
      });

      await flush();

      const stats = await portalQueueStats();
      await send(`DONE: swept ${done} board(s), ${found} relevant posting(s) seen, ${queued} newly queued. Queue now: ${stats.pending} pending, ${stats.applied} applied, ${stats.skipped} skipped.`);
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

export async function GET() {
  return Response.json(await portalQueueStats());
}
