export const maxDuration = 300;
export const dynamic = 'force-dynamic';

import { readMailInsightIds, addMailInsight } from '@/lib/db';
import { scanInboxForJobMail } from '@/lib/mail-scanner';
import { startRun, finishRun, isRunning } from '@/lib/mailScanRunState';
import { getConfiguredIdentities } from '@/lib/identities';

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
      const identities = getConfiguredIdentities();
      if (!identities.length) {
        await send('FATAL: No configured identity (SMTP_EMAIL/SMTP_APP_PASSWORD or SMTP_EMAIL_2/SMTP_APP_PASSWORD_2) — same Gmail app password used by the outreach reply-checker. No separate webhook or key needed, just set those env vars.');
        return;
      }

      // Scan every configured mailbox — inbound recruiter mail, assessment
      // invites, etc. can land in either identity's inbox depending on which
      // one the original outreach went out from.
      const knownIds = await readMailInsightIds();
      let allResults = [];
      for (const identity of identities) {
        await send(`ℹ [${identity.label}] Scanning inbox...`);
        const results = await scanInboxForJobMail({ sinceDays, knownIds, onProgress: send, identity }).catch((e) => {
          send(`  ⚠ [${identity.label}] Scan failed: ${e.message}`);
          return [];
        });
        for (const r of results) knownIds.add(r.messageId); // avoid re-saving if both mailboxes somehow see the same Message-ID
        allResults = allResults.concat(results);
      }

      let saved = 0;
      for (const insight of allResults) {
        const ok = await addMailInsight(insight).catch(() => null);
        if (ok) saved++;
      }

      const positive = allResults.filter(r => r.category === 'positive').length;
      const assessment = allResults.filter(r => r.category === 'assessment').length;
      await send(`DONE: Saved ${saved} new job-related email(s) across ${identities.length} mailbox(es) — ${positive} positive, ${assessment} assessment/test invite(s).`);
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
