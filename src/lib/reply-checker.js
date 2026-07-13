// Reads the user's own Gmail inbox (IMAP, read-only) looking for replies from
// contacts we've emailed, and classifies each with AI.

async function classifyReply(snippet) {
  const prompt = `Classify this email reply to a job outreach email. Reply with ONLY one word: "interested" if they want to talk/interview/schedule a call, "rejected" if they're declining or saying no openings, "auto-reply" if it's an out-of-office/automated bounce/acknowledgement, or "other" for anything else.

Email:
"""
${snippet.slice(0, 1000)}
"""`;

  try {
    if (process.env.GEMINI_API_KEY) {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genai.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const result = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }] });
      const word = result.response.text().trim().toLowerCase();
      if (['interested', 'rejected', 'auto-reply', 'other'].includes(word)) return word;
    }
  } catch {}

  try {
    if (process.env.OPENAI_API_KEY) {
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const res = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      });
      const word = res.choices[0].message.content.trim().toLowerCase();
      if (['interested', 'rejected', 'auto-reply', 'other'].includes(word)) return word;
    }
  } catch {}

  return 'other';
}

// contacts: array of { email, sentAt } for contacts already marked 'sent' with no reply recorded yet.
// onProgress(msg) called for log lines. Returns array of { email, replyStatus, replySnippet, repliedAt }.
export async function checkReplies(contacts, onProgress = () => {}) {
  const { ImapFlow } = await import('imapflow');
  const { simpleParser } = await import('mailparser');

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: process.env.SMTP_EMAIL, pass: process.env.SMTP_APP_PASSWORD },
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
        const replyStatus = await classifyReply(snippet);

        results.push({
          email: contact.email,
          replyStatus,
          replySnippet: snippet.slice(0, 300),
          repliedAt: parsed.date || new Date(),
        });
        onProgress(`✓ Reply from ${contact.companyName || contact.email}: ${replyStatus}`);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  return results;
}
