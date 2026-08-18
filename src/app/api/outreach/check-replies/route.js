export const maxDuration = 300;
export const dynamic = 'force-dynamic';

import { readOutreachContacts, updateOutreachContact, addOutreachContact, getIdentitySettings } from '@/lib/db';
import { checkReplies } from '@/lib/reply-checker';
import { checkBounces } from '@/lib/bounce-checker';
import { getConfiguredIdentities } from '@/lib/identities';
import { isExcludedOutreachDomain } from '@/lib/exclusions';
import { sendOutreachEmail } from '@/lib/mailer';
import { buildRelocationFollowUp, buildNoOpeningFollowUp } from '@/lib/followup-templates';
import { countSentToday, getDailyCap } from '@/lib/outreachCap';

export async function POST() {
  const encoder = new TextEncoder();
  const stream  = new TransformStream();
  const writer  = stream.writable.getWriter();
  const send    = (msg) => writer.write(encoder.encode(`data: ${JSON.stringify({ message: msg })}\n\n`)).catch(() => {});

  (async () => {
    try {
      const all = await readOutreachContacts();
      const identities = getConfiguredIdentities();

      // Each identity is a separate Gmail account/inbox — a bounce or reply to
      // a message sent from pa.devworks@gmail.com lands in THAT inbox, not
      // pulkitagarwal2020's. Check every configured identity's own mailbox
      // against only the contacts that were actually sent from it.
      let allBounces = [];
      let allResults = [];

      let referredCount = 0;
      let followUpCount = 0;

      for (const identity of identities) {
        // Legacy contacts sent before sentFromIdentity was tracked default to 'primary'.
        const contactsForIdentity = all.filter(c => (c.sentFromIdentity || 'primary') === identity.id);
        const byEmail = new Map(contactsForIdentity.map(c => [c.email.toLowerCase(), c]));
        const knownEmails = new Set(all.map(c => c.email.toLowerCase()));

        const sentEmails = new Set(contactsForIdentity.filter(c => c.status === 'sent').map(c => c.email.toLowerCase()));
        await send(`ℹ [${identity.label}] Checking inbox for delivery-failure notifications against ${sentEmails.size} 'sent' contact(s)...`);
        const bounces = await checkBounces(sentEmails, { identity, onProgress: send }).catch((e) => {
          send(`  ⚠ [${identity.label}] Bounce check failed: ${e.message}`);
          return [];
        });
        for (const b of bounces) {
          await updateOutreachContact(b.email, { status: 'bounced', lastFailReason: b.reason });
          await send(`  ✗ Bounced: ${b.email} — ${b.reason.slice(0, 100)}`);
        }
        if (bounces.length) await send(`  ${bounces.length} contact(s) re-marked as bounced.`);
        allBounces = allBounces.concat(bounces);

        const awaitingReply = contactsForIdentity.filter(c => c.status === 'sent' && !c.replyStatus && !bounces.some(b => b.email === c.email.toLowerCase()));
        await send(`ℹ [${identity.label}] Checking inbox for replies from ${awaitingReply.length} contact(s) awaiting a response...`);

        if (!awaitingReply.length) continue;

        const results = await checkReplies(awaitingReply, (msg) => send(msg), identity).catch((e) => {
          send(`  ⚠ [${identity.label}] Reply check failed: ${e.message}`);
          return [];
        });

        // Daily cap for follow-up sends from THIS identity — shares the same
        // ceiling as regular outreach (cold queue + manual), tracked live as
        // we send below since `all` was only read once at the top of this run.
        const settings = await getIdentitySettings(identity.id);
        const dailyCap = getDailyCap(settings);
        let sentTodayCount = countSentToday(all, identity.id);

        for (const r of results) {
          await updateOutreachContact(r.email, {
            replyStatus: r.replyStatus,
            replySnippet: r.replySnippet,
            repliedAt: r.repliedAt,
            altContactEmail: r.altEmail || undefined,
            locationObjection: r.locationObjection || undefined,
          });

          const contact = byEmail.get(r.email.toLowerCase());

          // "Please apply to this address instead" — enqueue it like any other
          // outreach lead; the existing send pipeline picks it up automatically
          // within the normal daily cap, no separate sending path needed.
          if (r.altEmail && !knownEmails.has(r.altEmail) && !isExcludedOutreachDomain(r.altEmail)) {
            const added = await addOutreachContact({
              companyName: contact?.companyName || 'your team',
              email: r.altEmail,
              source: 'referred',
              confidence: 'high',
            });
            if (added) {
              knownEmails.add(r.altEmail);
              referredCount++;
              await send(`  ↗ Referred to new address: ${r.altEmail} (from ${r.email}) — queued for outreach.`);
            }
          }

          // One follow-up per reply, sent as an actual threaded reply (same
          // subject/thread, In-Reply-To set) rather than a fresh email —
          // location objection is the more specific/actionable case, so it
          // takes priority over the generic "no openings" rejection.
          const followUpKind = r.locationObjection ? 'relocation' : r.replyStatus === 'rejected' ? 'no-opening' : null;
          if (followUpKind && contact) {
            if (sentTodayCount >= dailyCap) {
              await send(`  ⚠ [${identity.label}] Daily cap reached — skipping ${followUpKind} follow-up to ${r.email} (will not retry automatically).`);
            } else {
              try {
                const build = followUpKind === 'relocation' ? buildRelocationFollowUp : buildNoOpeningFollowUp;
                const { subject, text, html } = build(contact.companyName, identity.id, r.replySubject);
                await sendOutreachEmail({ to: r.email, subject, text, html, identityId: identity.id, inReplyTo: r.inReplyToMessageId });
                await updateOutreachContact(r.email, { followUpSentAt: new Date(), followUpReason: followUpKind });
                sentTodayCount++;
                followUpCount++;
                await send(`  ↻ Sent ${followUpKind} follow-up to ${r.email} via ${identity.label}`);
              } catch (e) {
                await send(`  ✗ ${followUpKind} follow-up failed for ${r.email}: ${e.message}`);
              }
            }
          }
        }
        allResults = allResults.concat(results);
      }

      const interested = allResults.filter(r => r.replyStatus === 'interested').length;
      const rejected = allResults.filter(r => r.replyStatus === 'rejected').length;
      await send(`DONE: ${allBounces.length} bounce(s), ${allResults.length} new repl(y/ies) across ${identities.length} identity(ies) — ${interested} interested, ${rejected} rejected, ${allResults.length - interested - rejected} other/auto. ${referredCount} referred to a new address, ${followUpCount} follow-up(s) sent.`);
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
