export const maxDuration = 600;
export const dynamic = 'force-dynamic';

import { fetchDirectory, harvestFromCdx, probeBoard, PROBE_CONCURRENCY, DIRECTORY_FILES } from '@/lib/ats-directory';
import { upsertAtsBoards, recordBoardProbe, readUnprobedBoards, atsBoardStats } from '@/lib/db';

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

// Ingests the ATS board universe and establishes which boards are live.
//
// Two phases, both resumable: ingest is an idempotent upsert, and probing
// works off "least recently probed" so an interrupted run simply continues
// where it left off on the next call rather than restarting.
//
// body: { sources?: ['directory'|'cdx'], probeLimit?, staleDays?, atsTypes? }
export async function POST(request) {
  const {
    sources = ['directory'],
    probeLimit = Number(process.env.BOARD_PROBE_LIMIT) || 6000,
    staleDays = 7,
    atsTypes = Object.keys(DIRECTORY_FILES),
  } = await request.json().catch(() => ({}));

  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const send = (m) => writer.write(encoder.encode(`data: ${JSON.stringify({ message: m })}\n\n`)).catch(() => {});

  (async () => {
    try {
      // ── Phase 1: ingest slugs ────────────────────────────────────────────
      let totalNew = 0;
      for (const atsType of atsTypes) {
        for (const source of sources) {
          let entries = [];
          try {
            entries = source === 'cdx'
              ? await harvestFromCdx(atsType, { onProgress: send })
              : await fetchDirectory(atsType);
          } catch (e) {
            await send(`⚠ ${atsType}/${source}: ${e.message.slice(0, 120)}`);
            continue;
          }
          if (!entries.length) continue;
          const { inserted } = await upsertAtsBoards(entries.map(e => ({ ...e, source })));
          totalNew += inserted;
          await send(`📥 ${atsType}/${source}: ${entries.length} slug(s) seen, ${inserted} new.`);
        }
      }
      await send(`📥 Ingest done — ${totalNew} board(s) added.`);

      // ── Phase 2: probe for liveness ──────────────────────────────────────
      // Directory membership is a claim; only a board that answers its public
      // API with real postings is usable by the apply flow.
      const pending = await readUnprobedBoards({ limit: probeLimit, staleDays });
      if (!pending.length) {
        await send('✓ Every board already has a fresh liveness verdict.');
      } else {
        await send(`🔎 Probing ${pending.length} board(s) for liveness...`);

        // Grouped by platform so each gets its own concurrency. Ashby rate
        // limits far more aggressively than Greenhouse, and one shared pool
        // would either crawl for everyone or get throttled by Ashby.
        const byType = {};
        for (const b of pending) (byType[b.atsType] ||= []).push(b);

        let live = 0, dead = 0, done = 0;
        await Promise.all(Object.entries(byType).map(([atsType, boards]) =>
          mapWithConcurrency(boards, PROBE_CONCURRENCY[atsType] || 10, async (b) => {
            const count = await probeBoard(atsType, b.slug);
            const isAlive = count !== null && count > 0;
            await recordBoardProbe(atsType, b.slug, { alive: isAlive, jobCount: count || 0 });
            if (isAlive) live++; else dead++;
            if (++done % 250 === 0) await send(`… ${done}/${pending.length} probed, ${live} live`);
          })
        ));
        await send(`🔎 Probe done — ${live} live, ${dead} empty/gone.`);
      }

      const stats = await atsBoardStats();
      const summary = Object.entries(stats)
        .map(([t, s]) => `${t}: ${s.live} live / ${s.total} known (${s.jobs.toLocaleString()} postings)`)
        .join(' · ');
      const totalLive = Object.values(stats).reduce((a, s) => a + s.live, 0);
      await send(`DONE: ${totalLive} live board(s). ${summary}`);
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

export async function GET() {
  return Response.json(await atsBoardStats());
}
