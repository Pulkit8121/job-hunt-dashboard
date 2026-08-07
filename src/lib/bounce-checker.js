// Reads the user's own Gmail inbox (IMAP, read-only) for delivery-failure
// notifications (RFC 3464 DSN bounces from mailer-daemon/postmaster) and maps
// each back to the original recipient. Gmail's outbound SMTP accepting a
// message (and it appearing in Sent Mail) only means Gmail itself relayed it —
// the RECEIVING mail server can still reject it afterward, and that rejection
// arrives asynchronously as a brand new message in the inbox, not as an error
// from the original send call. Nothing previously read these, so contacts
// whose mail actually bounced stayed marked 'sent' indefinitely.
function parseDsn(text) {
  const recipient =
    text.match(/Final-Recipient:\s*rfc822;\s*(\S+)/i)?.[1] ||
    text.match(/Original-Recipient:\s*rfc822;\s*(\S+)/i)?.[1] ||
    text.match(/The email account that you tried to reach[^:]*:\s*(\S+@\S+)/i)?.[1] ||
    null;
  const action = text.match(/Action:\s*(\S+)/i)?.[1]?.toLowerCase() || null;
  const statusCode = text.match(/Status:\s*(\S+)/i)?.[1] || null;
  const diagnostic = (text.match(/Diagnostic-Code:\s*([^\n]+)/i)?.[1] || '').replace(/\r$/, '').slice(0, 200);
  return { recipient: recipient?.toLowerCase() || null, action, statusCode, diagnostic };
}

// contactEmails: Set of lowercased emails currently marked 'sent', to only
// return bounces relevant to our own outreach (not any random bounce in the
// inbox from other mail this account has sent).
export async function checkBounces(contactEmails, { since, onProgress = () => {} } = {}) {
  const { ImapFlow } = await import('imapflow');

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
      const uids = await client.search({
        or: [{ from: 'mailer-daemon' }, { from: 'postmaster' }],
        ...(since ? { since } : {}),
      });
      onProgress(`  Found ${uids.length} delivery-failure notification(s) in inbox to check.`);

      for (const uid of uids) {
        const msg = await client.download(uid, undefined, { uid: false });
        const chunks = [];
        for await (const chunk of msg.content) chunks.push(chunk);
        const text = Buffer.concat(chunks).toString('utf8');

        const { recipient, action, statusCode, diagnostic } = parseDsn(text);
        if (!recipient || !contactEmails.has(recipient)) continue;
        if (action !== 'failed') continue; // skip 'delayed' notices — not a final bounce yet

        results.push({
          email: recipient,
          reason: `${statusCode || ''} ${diagnostic || 'Delivery failed'}`.trim(),
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  return results;
}
