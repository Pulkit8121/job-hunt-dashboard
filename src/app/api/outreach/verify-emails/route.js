export const maxDuration = 600;
export const dynamic = 'force-dynamic';

import { readOutreachContacts, updateOutreachContact } from '@/lib/db';
import { verifyEmailDeliverable } from '@/lib/email-verify';

// Pre-send MX-record check across all pending contacts, so the send queue only
// ever contains addresses whose domain can actually receive mail. Marks
// domain-dead addresses as status 'invalid' (distinct from 'bounced', which is
// reserved for a real SMTP-level rejection) so they're excluded from sends but
// stay visible/auditable rather than silently deleted.
export async function POST() {
  const encoder = new TextEncoder();
  const stream  = new TransformStream();
  const writer  = stream.writable.getWriter();
  const send    = (msg) => writer.write(encoder.encode(`data: ${JSON.stringify({ message: msg })}\n\n`)).catch(() => {});

  (async () => {
    try {
      const all = await readOutreachContacts();
      const pending = all.filter(c => c.status === 'pending');
      await send(`ℹ Checking ${pending.length} pending address(es) for a valid mail domain (MX record lookup)...`);

      let checked = 0;
      let valid = 0;
      let invalid = 0;
      const byReason = {};

      for (const contact of pending) {
        const result = await verifyEmailDeliverable(contact.email).catch(() => ({ valid: false, reason: 'lookup-error' }));
        checked++;

        if (result.valid) {
          valid++;
        } else {
          invalid++;
          byReason[result.reason] = (byReason[result.reason] || 0) + 1;
          await updateOutreachContact(contact.email, {
            status: 'invalid',
            lastFailReason: `Pre-send check failed: ${result.reason}`,
          }).catch(() => {});
        }

        if (checked % 200 === 0) {
          await send(`  ...${checked}/${pending.length} checked (${valid} valid, ${invalid} invalid so far)`);
        }
      }

      await send(`DONE: Checked ${checked}. ${valid} deliverable, ${invalid} invalid (no mail domain) — invalid ones marked and excluded from future sends. Breakdown: ${JSON.stringify(byReason)}`);
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
