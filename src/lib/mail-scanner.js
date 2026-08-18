// Scans the user's own Gmail inbox (IMAP, read-only — same credentials
// reply-checker.js already uses, no new webhook/key needed) for job-related
// mail and classifies each into: a positive response (interview/offer/next
// steps), an assessment/test invite, a rejection, or other. Broader in scope
// than reply-checker.js, which only looks at replies from tracked outreach
// contacts — this scans the whole inbox for anything job-related, including
// inbound recruiter mail and responses to Naukri/company-portal applications
// that reply-checker.js would never see.
import { completeText } from './llm.js';

const JOB_KEYWORD_RE = /\b(interview|assessment|online assessment|\boa\b|coding (?:test|challenge)|technical (?:screen|assessment)|hackerrank|codesignal|hirevue|karat|codility|offer letter|congratulations|application (?:received|update|status)|thank you for applying|next steps|recruiter|recruiting|hiring (?:team|manager)|position|job opportunity|role at|shortlisted|move forward|schedule a call|phone screen)\b/i;

function isLikelyJobRelated(subject = '', from = '') {
  return JOB_KEYWORD_RE.test(subject) || JOB_KEYWORD_RE.test(from);
}

async function classifyJobMail(subject, snippet) {
  const prompt = `Classify this job-search-related email. Reply with ONLY one word:
"positive" if it's an interview invite, offer, or a positive next-steps update,
"assessment" if it asks the candidate to complete a coding test/online assessment/technical screen,
"rejected" if they're declining or saying no openings,
"other" for anything else (newsletter, auto-reply, unrelated).

Subject: ${subject}

Email:
"""
${snippet.slice(0, 1500)}
"""`;

  const raw = await completeText(prompt);
  const word = (raw || '').trim().toLowerCase().replace(/[^a-z-]/g, '');
  if (['positive', 'assessment', 'rejected', 'other'].includes(word)) return word;
  // Distinguish "the model said other" from "no model answered" — the latter
  // used to be indistinguishable, which is how 111 unclassified emails were
  // mistaken for 111 confidently-classified ones.
  return raw ? 'other' : 'unclassified';
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i).catch(() => null);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// knownIds: Set of already-scanned Message-ID strings, to skip re-classifying
// mail we've already stored. onProgress(msg) called for log lines.
// Returns array of { messageId, from, subject, snippet, category, receivedAt }.
export async function scanInboxForJobMail({ sinceDays = 30, knownIds = new Set(), onProgress = () => {}, identity } = {}) {
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

  const since = new Date(Date.now() - sinceDays * 86400000);
  const candidates = [];
  let totalScanned = 0;

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ since }, { uid: true });
      totalScanned = uids.length;
      onProgress(`ℹ Found ${uids.length} message(s) in the last ${sinceDays} days. Filtering for job-related mail...`);

      // Bulk-fetch envelopes (then bodies) in one IMAP round trip each instead
      // of one fetchOne() per message — with a few hundred messages in the
      // window, fetching one at a time is the difference between seconds and
      // minutes on a single IMAP connection.
      if (uids.length) {
        for await (const msg of client.fetch(uids, { envelope: true }, { uid: true })) {
          if (!msg?.envelope) continue;
          const subject = msg.envelope.subject || '';
          const from = msg.envelope.from?.[0]?.address || '';
          const rawMessageId = msg.envelope.messageId || `${msg.uid}:${from}:${subject}`;
          if (knownIds.has(rawMessageId)) continue;
          if (!isLikelyJobRelated(subject, from)) continue;
          candidates.push({ uid: msg.uid, subject, from, rawMessageId });
        }
      }
      onProgress(`ℹ ${candidates.length} job-related candidate(s) to classify.`);

      if (candidates.length) {
        const byUid = new Map(candidates.map(c => [c.uid, c]));
        for await (const msg of client.fetch(candidates.map(c => c.uid), { source: true }, { uid: true })) {
          const candidate = byUid.get(msg.uid);
          if (candidate && msg?.source) candidate.source = msg.source;
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  // Classification hits external AI APIs, not the mailbox — parallelize now
  // that the (single, non-concurrent-safe) IMAP connection is closed.
  const classified = await mapWithConcurrency(candidates.filter(c => c.source), 4, async (candidate) => {
    const parsed = await simpleParser(candidate.source);
    const snippet = (parsed.text || parsed.html || '').slice(0, 2000);
    const category = await classifyJobMail(candidate.subject, snippet);

    const icon = category === 'positive' ? '🎯' : category === 'assessment' ? '📝'
      : category === 'rejected' ? '✗' : category === 'unclassified' ? '⚠' : '•';
    onProgress(`${icon} ${candidate.subject.slice(0, 70)} — ${category}`);

    return {
      messageId: candidate.rawMessageId,
      from: candidate.from,
      subject: candidate.subject,
      snippet: snippet.slice(0, 400),
      category,
      receivedAt: parsed.date || new Date(),
      mailbox: id.email,
    };
  });

  const results = classified.filter(Boolean);
  onProgress(`ℹ Classified ${results.length} new job-related email(s) out of ${totalScanned} scanned.`);
  return results;
}
