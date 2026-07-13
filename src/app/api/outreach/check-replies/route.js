export const maxDuration = 300;
export const dynamic = 'force-dynamic';

import { readOutreachContacts, updateOutreachContact } from '@/lib/db';
import { checkReplies } from '@/lib/reply-checker';

export async function POST() {
  const encoder = new TextEncoder();
  const stream  = new TransformStream();
  const writer  = stream.writable.getWriter();
  const send    = (msg) => writer.write(encoder.encode(`data: ${JSON.stringify({ message: msg })}\n\n`));

  (async () => {
    try {
      const all = await readOutreachContacts();
      const awaitingReply = all.filter(c => c.status === 'sent' && !c.replyStatus);
      await send(`ℹ Checking inbox for replies from ${awaitingReply.length} contact(s) awaiting a response...`);

      if (!awaitingReply.length) {
        await send('DONE: No contacts awaiting a reply check.');
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
      await send(`DONE: Found ${results.length} new repl(y/ies) — ${interested} interested, ${rejected} rejected, ${results.length - interested - rejected} other/auto.`);
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
