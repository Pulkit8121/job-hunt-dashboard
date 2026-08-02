export const maxDuration = 600;
export const dynamic = 'force-dynamic';

import { readOutreachContacts, updateOutreachContact } from '@/lib/db';
import { generateCoverLetter } from '@/lib/cover-letter';
import { sendOutreachEmail, sleep, classifySendError } from '@/lib/mailer';

const MAX_TRANSIENT_RETRIES = 3;
import { startRun, finishRun, isRunning } from '@/lib/outreachRunState';
import { isExcludedOutreachDomain } from '@/lib/exclusions';

// Sends are spread across the day by an hourly cron (small batches per run), so
// the in-run spacing just needs to avoid bursting within a batch — 10-25s is
// plenty. The real rate limiting is the per-run `limit` + the daily cap.
const MIN_DELAY_MS = 10000;
const MAX_DELAY_MS = 25000;

// Absolute ceiling on real outreach emails sent per day, regardless of a higher
// OUTREACH_DAILY_CAP — a personal Gmail account's hard technical limit is ~500
// recipients/day, and crossing it gets sends blocked. We stay meaningfully below
// that so a spike (retries, a manual run on top of the cron) can't tip over.
// Not env-configurable so a stale/huge value on the server can't silently blow
// past Gmail's limit and freeze the account.
const HARD_MAX_DAILY_SENDS = 400;

function isToday(date) {
  if (!date) return false;
  const d = new Date(date);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

// Emails go out in one bulk burst → spam filters. Spreading the day's remaining
// quota evenly across the hours left (the send cron fires hourly, 24/7) keeps
// each batch small so Gmail sees a steady human-like trickle, not a blast. Uses
// hours-until-midnight so the day's allotment is paced to finish by ~midnight.
function perRunSpread(remainingToday) {
  const hoursLeftToday = Math.max(1, 24 - new Date().getHours());
  return Math.max(1, Math.ceil(remainingToday / hoursLeftToday));
}

export async function POST(request) {
  const { limit } = await request.json().catch(() => ({}));

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

  const controller = startRun();
  const signal = controller.signal;

  (async () => {
    try {
      const dailyCap = Math.min(Number(process.env.OUTREACH_DAILY_CAP) || 200, HARD_MAX_DAILY_SENDS);
      const all = await readOutreachContacts();
      const sentToday = all.filter(c => c.status === 'sent' && isToday(c.sentAt)).length;
      const remainingToday = Math.max(0, dailyCap - sentToday);
      const pending = all.filter(c => c.status === 'pending');

      // Trickle: bound every run to an even slice of what's left for the day so
      // the hourly cron paces the whole daily quota out instead of bursting it —
      // the spread always applies (even when the cron passes a big `limit`),
      // because the burst is exactly what triggers spam filters.
      const spread = perRunSpread(remainingToday);
      const cap = Math.min(pending.length, remainingToday, limit || Infinity, spread);

      await send(`ℹ ${pending.length} pending · ${sentToday}/${dailyCap} sent today · trickling ~${spread}/hr → sending up to ${cap} this run.`);

      if (cap <= 0) {
        await send(sentToday >= dailyCap
          ? 'DONE: Daily send cap reached. Resume tomorrow.'
          : 'DONE: No pending contacts to send to.');
        return;
      }

      let sent = 0;
      let failed = 0;

      for (const contact of pending.slice(0, cap)) {
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
          await send(`✉ Preparing cover letter for ${contact.companyName}...`);
          const { text, html } = await generateCoverLetter(contact.companyName);
          await sendOutreachEmail({
            to: contact.email,
            subject: `Full-Stack AI Engineer — application for ${contact.companyName}`,
            text,
            html,
          });
          await updateOutreachContact(contact.email, {
            status: 'sent',
            sentAt: new Date(),
            coverLetter: text,
          });
          sent++;
          await send(`✓ Sent to ${contact.companyName} (${contact.email})`);
        } catch (e) {
          failed++;
          await send(`✗ Failed for ${contact.companyName} (${contact.email}): ${e.message}`);

          const kind = classifySendError(e);
          if (kind === 'quota') {
            await send('⛔ Gmail daily sending limit reached — stopping this run. Will resume once the cap resets tomorrow.');
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
