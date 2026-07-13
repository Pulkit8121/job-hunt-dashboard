export const maxDuration = 600;
export const dynamic = 'force-dynamic';

import { readOutreachContacts, updateOutreachContact } from '@/lib/db';
import { generateCoverLetter } from '@/lib/cover-letter';
import { sendOutreachEmail, sleep } from '@/lib/mailer';
import { startRun, finishRun, isRunning } from '@/lib/outreachRunState';
import { isExcludedOutreachDomain } from '@/lib/exclusions';

const MIN_DELAY_MS = 20000;
const MAX_DELAY_MS = 45000;

function isToday(date) {
  if (!date) return false;
  const d = new Date(date);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

export async function POST(request) {
  const { limit } = await request.json().catch(() => ({}));

  const encoder = new TextEncoder();
  const stream  = new TransformStream();
  const writer  = stream.writable.getWriter();
  const send    = (msg) => writer.write(encoder.encode(`data: ${JSON.stringify({ message: msg })}\n\n`));

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
      const dailyCap = Number(process.env.OUTREACH_DAILY_CAP) || 400;
      const all = await readOutreachContacts();
      const sentToday = all.filter(c => c.status === 'sent' && isToday(c.sentAt)).length;
      const remainingToday = Math.max(0, dailyCap - sentToday);
      const pending = all.filter(c => c.status === 'pending');

      const cap = Math.min(pending.length, remainingToday, limit || Infinity);

      await send(`ℹ ${pending.length} pending contact(s). ${sentToday}/${dailyCap} already sent today. Sending up to ${cap} this run.`);

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
          const coverLetter = await generateCoverLetter(contact.companyName);
          await sendOutreachEmail({
            to: contact.email,
            subject: `Full-Stack AI Engineer — application for ${contact.companyName}`,
            text: coverLetter,
          });
          await updateOutreachContact(contact.email, {
            status: 'sent',
            sentAt: new Date(),
            coverLetter,
          });
          sent++;
          await send(`✓ Sent to ${contact.companyName} (${contact.email})`);
        } catch (e) {
          failed++;
          await send(`✗ Failed for ${contact.companyName} (${contact.email}): ${e.message}`);
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
