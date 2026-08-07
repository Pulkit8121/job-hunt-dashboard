export const maxDuration = 300;
export const dynamic = 'force-dynamic';

import { readOutreachContacts, updateOutreachContact } from '@/lib/db';
import { checkReplies } from '@/lib/reply-checker';
import { checkBounces } from '@/lib/bounce-checker';

export async function POST() {
  const encoder = new TextEncoder();
  const stream  = new TransformStream();
  const writer  = stream.writable.getWriter();
  const send    = (msg) => writer.write(encoder.encode(`data: ${JSON.stringify({ message: msg })}\n\n`)).catch(() => {});

  (async () => {
    try {
      const all = await readOutreachContacts();

      // Bounce check first: Gmail accepting a send only means it left our
      // outbox — the receiving server can still reject it, which shows up as a
      // separate delivery-failure notification in the inbox, not as an error
      // on the original send. Contacts marked 'sent' may actually have bounced.
      const sentEmails = new Set(all.filter(c => c.status === 'sent').map(c => c.email.toLowerCase()));
      await send(`ℹ Checking inbox for delivery-failure notifications against ${sentEmails.size} 'sent' contact(s)...`);
      const bounces = await checkBounces(sentEmails, { onProgress: send }).catch((e) => {
        send(`  ⚠ Bounce check failed: ${e.message}`);
        return [];
      });
      for (const b of bounces) {
        await updateOutreachContact(b.email, { status: 'bounced', lastFailReason: b.reason });
        await send(`  ✗ Bounced: ${b.email} — ${b.reason.slice(0, 100)}`);
      }
      if (bounces.length) await send(`  ${bounces.length} contact(s) re-marked as bounced.`);

      const awaitingReply = all.filter(c => c.status === 'sent' && !c.replyStatus && !bounces.some(b => b.email === c.email.toLowerCase()));
      await send(`ℹ Checking inbox for replies from ${awaitingReply.length} contact(s) awaiting a response...`);

      if (!awaitingReply.length) {
        await send(`DONE: ${bounces.length} bounce(s) found. No contacts awaiting a reply check.`);
        return;
      }

      const results = await checkReplies(awaitingReply, (msg) => send(msg));

      for (const r of results) {
        await updateOutreachContact(r.email, {
          replyStatus: r.replyStatus,
          replySnippet: r.replySnippet,
          repliedAt: r.repliedAt,
        });
      }

      const interested = results.filter(r => r.replyStatus === 'interested').length;
      const rejected = results.filter(r => r.replyStatus === 'rejected').length;
      await send(`DONE: ${bounces.length} bounce(s), ${results.length} new repl(y/ies) — ${interested} interested, ${rejected} rejected, ${results.length - interested - rejected} other/auto.`);
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
