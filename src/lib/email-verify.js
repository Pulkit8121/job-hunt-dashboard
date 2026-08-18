// Pre-send email deliverability check — syntax + DNS MX record lookup. Uses
// Node's built-in `dns` module only (no third-party API, no external repo/
// dependency to trust) — this is the same check any mail server does before
// accepting a message: does the domain even have a mail exchanger?
//
// What this catches: typos, dead/expired domains, non-existent domains — the
// majority of real "invalid address" bounces.
// What this CANNOT catch: a domain with valid MX records but a specific
// mailbox that doesn't exist (e.g. "wrongname@realcompany.com") — only an
// actual SMTP RCPT TO probe or a real send attempt reveals that, and mailbox-
// level probing is itself flagged as abuse by most receiving servers, so it's
// deliberately not attempted here.
import dns from 'dns';
import { promisify } from 'util';

const resolveMx = promisify(dns.resolveMx);

const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

// Cache MX lookups per domain for the lifetime of the process — many contacts
// share a company domain, no reason to re-resolve it every time.
const mxCache = new Map();

async function domainHasMx(domain) {
  if (mxCache.has(domain)) return mxCache.get(domain);
  let ok = false;
  try {
    const records = await resolveMx(domain);
    ok = Array.isArray(records) && records.length > 0;
  } catch {
    ok = false; // NXDOMAIN, no MX, timeout, etc. — treat as undeliverable
  }
  mxCache.set(domain, ok);
  return ok;
}

// Returns { valid, reason } — reason is set only when valid is false.
export async function verifyEmailDeliverable(email) {
  const trimmed = (email || '').trim();
  if (!EMAIL_RE.test(trimmed)) {
    return { valid: false, reason: 'invalid-syntax' };
  }
  const domain = trimmed.split('@')[1].toLowerCase();
  const hasMx = await domainHasMx(domain);
  if (!hasMx) {
    return { valid: false, reason: 'no-mx-record' };
  }
  return { valid: true, reason: null };
}

// Verifies a batch with bounded concurrency — DNS lookups are cheap but
// hundreds sequentially would be slow; a few thousand all at once would be
// needless self-inflicted DNS load.
export async function verifyEmailsBatch(emails, { concurrency = 20, onProgress } = {}) {
  const results = new Map();
  const queue = [...emails];
  let done = 0;

  async function worker() {
    while (queue.length) {
      const email = queue.pop();
      const result = await verifyEmailDeliverable(email).catch(() => ({ valid: false, reason: 'lookup-error' }));
      results.set(email, result);
      done++;
      if (onProgress && done % 100 === 0) onProgress(done, emails.length);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}
