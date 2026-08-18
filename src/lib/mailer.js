import path from 'path';
import { getIdentity } from './identities.js';

// One transporter per identity (two separate Gmail accounts, two separate SMTP
// sessions) — cached by identity id so repeated sends don't reconnect each time.
const transporters = new Map();

async function getTransporter(identity) {
  if (transporters.has(identity.id)) return transporters.get(identity.id);
  const nodemailer = (await import('nodemailer')).default;
  const t = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: identity.email,
      pass: identity.appPassword,
    },
  });
  transporters.set(identity.id, t);
  return t;
}

// Gmail renders plain-text-only emails in a small default font. We send an HTML
// version wrapped in one consistent, readable font/size so it's legible instead
// of tiny. If a pre-built html fragment (with intentional bold) is passed we use
// it; otherwise we derive a plain, unstyled HTML from the text. Either way the
// raw `text` is still sent alongside as the fallback for plain-text clients.
function wrapHtml(htmlFragment) {
  return `<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.6; color: #202124;">${htmlFragment}</div>`;
}

function textToHtml(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  return wrapHtml(escaped);
}

// inReplyTo: the Message-ID of the email being replied to — when set, this
// goes out as an actual threaded reply (In-Reply-To/References headers) that
// lands in the same conversation in the recipient's client, not a new email.
export async function sendOutreachEmail({ to, subject, text, html, identityId = 'primary', inReplyTo }) {
  const identity = getIdentity(identityId);
  if (!identity.appPassword) {
    throw new Error(`Identity "${identityId}" has no app password configured — cannot send.`);
  }
  const resumePath = path.resolve(process.cwd(), identity.resumePath);
  const t = await getTransporter(identity);
  return t.sendMail({
    from: `"${identity.displayName}" <${identity.email}>`,
    to,
    subject,
    text,
    html: html ? wrapHtml(html) : textToHtml(text),
    attachments: [{ filename: identity.resumeFilename, path: resumePath }],
    ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}),
  });
}

// For internal notifications (e.g. the nightly report) — no resume attachment,
// sent from whichever identity is asked (defaults to primary).
export async function sendPlainEmail({ to, subject, text, html, identityId = 'primary' }) {
  const identity = getIdentity(identityId);
  if (!identity.appPassword) {
    throw new Error(`Identity "${identityId}" has no app password configured — cannot send.`);
  }
  const t = await getTransporter(identity);
  return t.sendMail({
    from: `"${identity.displayName}" <${identity.email}>`,
    to,
    subject,
    text,
    html: html ? wrapHtml(html) : textToHtml(text),
  });
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Classifies an SMTP send failure so the caller knows how to react:
//   'quota'     — OUR account hit Gmail's daily sending limit. Not the
//                 recipient's fault; every remaining send this run will fail
//                 identically, so the caller should stop the whole run rather
//                 than keep burning through the queue.
//   'permanent' — the recipient address itself is bad (doesn't exist, mailbox
//                 rejected, etc.) — retrying will never succeed.
//   'transient' — anything else (network blip, temporary greylisting) — worth
//                 retrying a bounded number of times, not forever.
export function classifySendError(err) {
  const msg = (err?.message || err?.response || '').toLowerCase();

  if (/daily user sending limit exceeded|550-5\.4\.5/.test(msg)) {
    return 'quota';
  }

  if (/no such user|user unknown|mailbox unavailable|mailbox not found|does not exist|address rejected|recipient rejected|invalid recipient|mailbox name not allowed|no mailbox|550 5\.1\.|551 |553 /.test(msg)) {
    return 'permanent';
  }

  return 'transient';
}
