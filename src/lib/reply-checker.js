// Reads the user's own Gmail inbox (IMAP, read-only) looking for replies from
// contacts we've emailed, and classifies each with AI.
import { completeText } from './llm.js';

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

// One LLM call per reply, extracting three things at once (status + two
// action triggers) instead of three separate calls. A strict line-based
// format rather than JSON — small, cheap models follow "LABEL: value" far
// more reliably than balanced-brace JSON, and parsing is a single regex per
// line with a safe default if the model ever deviates.
async function classifyReplyDetails(snippet, originalEmail) {
  const prompt = `You are triaging a reply to a cold job-outreach email. Read it and answer in EXACTLY this 3-line format, nothing else:
STATUS: <interested, rejected, auto-reply, or other>
ALT_EMAIL: <a different email address they explicitly asked us to use instead, or "none">
LOCATION_OBJECTION: <"yes" only if they're declining/qualifying because the role/team is based somewhere the candidate isn't (e.g. "we only hire locally in Belgium/Europe"), else "no">

STATUS meanings: "interested" = wants to talk/interview/schedule a call. "rejected" = declining or no openings. "auto-reply" = out-of-office/automated bounce/acknowledgement. "other" = anything else.

Reply:
"""
${snippet.slice(0, 1200)}
"""`;

  const raw = await completeText(prompt);
  const status = (raw?.match(/STATUS:\s*([a-z-]+)/i)?.[1] || '').toLowerCase();
  const replyStatus = ['interested', 'rejected', 'auto-reply', 'other'].includes(status) ? status : 'other';

  let altEmail = raw?.match(/ALT_EMAIL:\s*(\S+)/i)?.[1]?.toLowerCase().replace(/[,.;]$/, '');
  if (!altEmail || altEmail === 'none' || !EMAIL_RE.test(altEmail) || altEmail === originalEmail?.toLowerCase()) {
    altEmail = null;
  }

  const locationObjection = (raw?.match(/LOCATION_OBJECTION:\s*(yes|no)/i)?.[1] || '').toLowerCase() === 'yes';

  return { replyStatus, altEmail, locationObjection };
}

// contacts: array of { email, sentAt } for contacts already marked 'sent' with no reply recorded yet —
// must all have been sent from the SAME identity as `identity`, since a reply
// to a message sent from pa.devworks@gmail.com lands in that inbox, not
// pulkitagarwal2020's. onProgress(msg) called for log lines.
// Returns array of { email, replyStatus, replySnippet, repliedAt }.
export async function checkReplies(contacts, onProgress = () => {}, identity) {
  const { ImapFlow } = await import('imapflow');
  const { simpleParser } = await import('mailparser');
  const { getIdentity } = await import('./identities.js');
  const id = identity || getIdentity('primary');

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: id.email, pass: id.appPassword },
    logger: false,
  });

  const results = [];

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      for (const contact of contacts) {
        const since = contact.sentAt ? new Date(contact.sentAt) : undefined;
        const uids = await client.search({ from: contact.email, ...(since ? { since } : {}) }, { uid: true });
        if (!uids || !uids.length) continue;

        const latestUid = uids[uids.length - 1];
        const message = await client.fetchOne(latestUid, { source: true }, { uid: true });
        if (!message?.source) continue;

        const parsed = await simpleParser(message.source);
        const snippet = (parsed.text || parsed.html || '').slice(0, 2000);
        const { replyStatus, altEmail, locationObjection } = await classifyReplyDetails(snippet, contact.email);

        results.push({
          email: contact.email,
          replyStatus,
          replySnippet: snippet.slice(0, 300),
          repliedAt: parsed.date || new Date(),
          altEmail,
          locationObjection,
          // For threading a follow-up as an actual reply in this same thread
          // rather than a new email — nodemailer's In-Reply-To/References.
          inReplyToMessageId: parsed.messageId || null,
          replySubject: parsed.subject || null,
        });
        const flags = [altEmail ? `alt-email: ${altEmail}` : null, locationObjection ? 'location-objection' : null].filter(Boolean);
        onProgress(`✓ Reply from ${contact.companyName || contact.email}: ${replyStatus}${flags.length ? ` (${flags.join(', ')})` : ''}`);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  return results;
}
