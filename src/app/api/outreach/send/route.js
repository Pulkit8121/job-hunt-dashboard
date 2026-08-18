export const maxDuration = 600;
export const dynamic = 'force-dynamic';

import { readOutreachContacts, updateOutreachContact, getIdentitySettings } from '@/lib/db';
import { generateCoverLetter } from '@/lib/cover-letter';
import { sendOutreachEmail, sleep, classifySendError } from '@/lib/mailer';
import { getIdentity, isIdentityConfigured } from '@/lib/identities';

const MAX_TRANSIENT_RETRIES = 3;
import { startRun, finishRun, isRunning } from '@/lib/outreachRunState';
import { isExcludedOutreachDomain } from '@/lib/exclusions';
import { countSentToday, getDailyCap } from '@/lib/outreachCap';

// Sends are spread across the day by an hourly cron (small batches per run), so
// the in-run spacing just needs to avoid bursting within a batch — 10-25s is
// plenty. The real rate limiting is the per-run `limit` + the daily cap.
const MIN_DELAY_MS = 10000;
const MAX_DELAY_MS = 25000;

// Emails go out in one bulk burst → spam filters. Spreading the day's remaining
// quota evenly across the hours left (the send cron fires hourly, 24/7) keeps
// each batch small so Gmail sees a steady human-like trickle, not a blast. Uses
// hours-until-midnight so the day's allotment is paced to finish by ~midnight.
function perRunSpread(remainingToday) {
  const hoursLeftToday = Math.max(1, 24 - new Date().getHours());
  return Math.max(1, Math.ceil(remainingToday / hoursLeftToday));
}

export async function POST(request) {
  // explicitCount: the dashboard's "send this many today" number box — an
  // exact, user-chosen target for this run, so it bypasses the trickle-spread
  // pacing (that pacing exists to stop an unattended cron from bursting; a
  // number the user just typed in and clicked Send on is not a burst).
  const { limit, explicitCount, identityId = 'primary', retryBounced = false } = await request.json().catch(() => ({}));

  const encoder = new TextEncoder();
  const stream  = new TransformStream();
  const writer  = stream.writable.getWriter();
  const send    = (msg) => writer.write(encoder.encode(`data: ${JSON.stringify({ message: msg })}\n\n`)).catch(() => {});

  if (isRunning()) {
    await send('⚠ An outreach send run is already in progress. Stop it first if you want to restart.');
    await writer.close().catch(() => {});
    return new Response(stream.readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
    });
  }

  if (!isIdentityConfigured(identityId)) {
    await send(`FATAL: Identity "${identityId}" has no app password configured yet — add it to .env.local first.`);
    await writer.close().catch(() => {});
    return new Response(stream.readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
    });
  }

  const controller = startRun();
  const signal = controller.signal;
  const identity = getIdentity(identityId);

  (async () => {
    try {
      const settings = await getIdentitySettings(identityId);

      if (!settings.autoSendEnabled) {
        await send(`DONE: Automatic sending is turned off for ${identity.label}. Flip its switch back on in the dashboard to resume, or use "Send Manually" for one-off sends.`);
        return;
      }

      const dailyCap = getDailyCap(settings);
      const all = await readOutreachContacts();
      // Each identity is a separate Gmail account with its own independent
      // sending quota/reputation, so today's count only looks at sends that
      // actually went out from THIS identity — this already includes bulk-queue
      // sends, one-off manual sends, AND relocation follow-ups (all set
      // sentFromIdentity, and countSentToday combines them against one shared
      // per-identity ceiling).
      const sentToday = countSentToday(all, identityId);
      const remainingToday = Math.max(0, dailyCap - sentToday);
      const queue = retryBounced
        ? all.filter(c => c.status === 'bounced')
        : all.filter(c => c.status === 'pending');

      // Trickle: bound every run to an even slice of what's left for the day so
      // an unattended cron paces the whole daily quota out instead of bursting
      // it — the burst is exactly what triggers spam filters. An explicit,
      // user-typed count skips this pacing (still hard-capped by what's left
      // for the day) since it's a deliberate one-time batch, not a cron tick.
      const spread = explicitCount ? Infinity : perRunSpread(remainingToday);
      const requested = explicitCount || limit || Infinity;
      const cap = Math.min(queue.length, remainingToday, requested, spread);

      await send(`ℹ [${identity.label}] ${queue.length} ${retryBounced ? 'bounced (retrying)' : 'pending'} · ${sentToday}/${dailyCap} sent today from this identity · sending up to ${cap} this run.`);

      if (cap <= 0) {
        await send(sentToday >= dailyCap
          ? 'DONE: Daily send cap reached for this identity. Resume tomorrow.'
          : `DONE: No ${retryBounced ? 'bounced' : 'pending'} contacts to send to.`);
        return;
      }

      let sent = 0;
      let failed = 0;

      for (const contact of queue.slice(0, cap)) {
        if (signal.aborted) {
          await send('⏹ Stopped by user.');
          break;
        }

        if (isExcludedOutreachDomain(contact.email)) {
          await updateOutreachContact(contact.email, { status: 'skipped' });
          await send(`○ Skipped ${contact.companyName} (${contact.email}) — blocked domain (current employer / freelance client).`);
          continue;
        }

        try {
          await send(`✉ Preparing cover letter for ${contact.companyName} (via ${identity.label})...`);
          const { text, html } = await generateCoverLetter(contact.companyName, identityId);
          // Defense-in-depth: whatever a discovery source put in companyName,
          // a real recruiter's inbox is not the place to discover it was
          // actually a raw sentence/HTML fragment — collapse whitespace and
          // cap length so a subject line can never come out mangled.
          const safeCompanyName = (contact.companyName || 'your team').replace(/\s+/g, ' ').trim().slice(0, 60);
          await sendOutreachEmail({
            to: contact.email,
            subject: `Full-Stack AI Engineer — application for ${safeCompanyName}`,
            text,
            html,
            identityId,
          });
          await updateOutreachContact(contact.email, {
            status: 'sent',
            sentAt: new Date(),
            coverLetter: text,
            sentFromIdentity: identityId,
            failCount: 0,
          });
          sent++;
          await send(`✓ Sent to ${contact.companyName} (${contact.email}) via ${identity.label}`);
        } catch (e) {
          failed++;
          await send(`✗ Failed for ${contact.companyName} (${contact.email}): ${e.message}`);

          const kind = classifySendError(e);
          if (kind === 'quota') {
            await send(`⛔ ${identity.label} hit its daily sending limit — stopping this run. Will resume once the cap resets tomorrow.`);
            break;
          }

          if (kind === 'permanent') {
            await updateOutreachContact(contact.email, { status: 'bounced', lastFailReason: e.message.slice(0, 300) });
            await send(`  ⊘ Undeliverable address — marked bounced, won't retry.`);
          } else {
            const failCount = (contact.failCount || 0) + 1;
            if (failCount >= MAX_TRANSIENT_RETRIES) {
              await updateOutreachContact(contact.email, {
                status: 'bounced',
                lastFailReason: `Gave up after ${failCount} failures: ${e.message.slice(0, 200)}`,
              });
              await send(`  ⊘ Failed ${failCount} times — giving up, marked bounced.`);
            } else {
              await updateOutreachContact(contact.email, { failCount, lastFailReason: e.message.slice(0, 300) });
            }
          }
        }

        if (signal.aborted) {
          await send('⏹ Stopped by user.');
          break;
        }

        const delay = MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
        await sleep(delay);
      }

      if (signal.aborted) {
        await send(`STOPPED: Sent ${sent}, ${failed} failed before stopping.`);
      } else {
        await send(`DONE: Sent ${sent}, ${failed} failed.`);
      }
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
