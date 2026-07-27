export const maxDuration = 300;
export const dynamic = 'force-dynamic';

import { readMailInsightIds, addMailInsight } from '@/lib/db';
import { scanInboxForJobMail } from '@/lib/mail-scanner';
import { startRun, finishRun, isRunning } from '@/lib/mailScanRunState';

export async function POST(request) {
  const { sinceDays = 30 } = await request.json().catch(() => ({}));

  const encoder = new TextEncoder();
  const stream  = new TransformStream();
  const writer  = stream.writable.getWriter();
  const send    = (msg) => writer.write(encoder.encode(`data: ${JSON.stringify({ message: msg })}\n\n`)).catch(() => {});

  if (isRunning()) {
    await send('⚠ A mail scan is already in progress. Skipping this trigger.');
    await writer.close().catch(() => {});
    return new Response(stream.readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
    });
  }
  startRun();

  (async () => {
    try {
      if (!process.env.SMTP_EMAIL || !process.env.SMTP_APP_PASSWORD) {
        await send('FATAL: SMTP_EMAIL / SMTP_APP_PASSWORD not set — same Gmail app password used by the outreach reply-checker. No separate webhook or key needed, just set those two env vars.');
        return;
      }

      const knownIds = await readMailInsightIds();
      const results = await scanInboxForJobMail({ sinceDays, knownIds, onProgress: send });

      let saved = 0;
      for (const insight of results) {
        const ok = await addMailInsight(insight).catch(() => null);
        if (ok) saved++;
      }

      const positive = results.filter(r => r.category === 'positive').length;
      const assessment = results.filter(r => r.category === 'assessment').length;
      await send(`DONE: Saved ${saved} new job-related email(s) — ${positive} positive, ${assessment} assessment/test invite(s).`);
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
