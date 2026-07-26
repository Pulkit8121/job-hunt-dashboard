// Extra contact-discovery sources, ported from the two scraper repos.
//
// 1. Hunter.io domain search — the useful half of MickeyUK/map-email-scraper.
//    That repo pairs Google Maps business lookup with Hunter.io to find a
//    business's public emails; we already know each company's domain, so only
//    the Hunter half adds anything. Finds addresses that aren't printed on any
//    crawlable page, which is exactly what outreach-discovery.js (regex over
//    public HTML) structurally cannot do.
//    Optional: requires HUNTER_API_KEY. Free tier is ~25 searches/month, so
//    calls are capped and highest-value companies go first.
//
// 2. Startup/agency directory scrape — FilipGrebowski/company-email-scraper
//    fetches company emails from Seedtable and Clutch. Those pages are
//    server-rendered listings, so a plain fetch + regex works without a browser.
import { isExcludedOutreachDomain } from './exclusions.js';

const UA = 'Mozilla/5.0 (compatible; JobHuntBot/1.0; personal job-search tool)';
const FETCH_TIMEOUT = 12000;

const HR_PREFIXES = ['careers', 'career', 'hr', 'talent', 'recruit', 'recruiting', 'jobs', 'hiring', 'people', 'apply'];
const JUNK_LOCAL = ['noreply', 'no-reply', 'donotreply', 'webmaster', 'privacy', 'legal', 'abuse', 'unsubscribe', 'postmaster'];

function scoreEmail(email) {
  const [local] = email.toLowerCase().split('@');
  if (HR_PREFIXES.some(p => local.startsWith(p))) return 3;
  if (['info', 'contact', 'hello', 'team'].some(p => local.startsWith(p))) return 2;
  return 1;
}

function isUsable(email) {
  const [local, domain] = (email || '').toLowerCase().split('@');
  if (!local || !domain) return false;
  if (JUNK_LOCAL.some(j => local.includes(j))) return false;
  if (isExcludedOutreachDomain(email)) return false;
  return true;
}

function domainFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return null; }
}

// ── 1. Hunter.io ─────────────────────────────────────────────────────────────
// Returns { email, confidence, source } or null. `confidence` mirrors the
// existing OutreachContact vocabulary ('high' | 'medium' | 'low') rather than
// Hunter's 0-100 score, so it slots into the same UI.
export async function findEmailViaHunter(companyOrDomain) {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) return null;

  const domain = companyOrDomain.includes('://')
    ? domainFromUrl(companyOrDomain)
    : companyOrDomain.replace(/^www\./, '').toLowerCase();
  if (!domain || !domain.includes('.')) return null;
  if (isExcludedOutreachDomain(domain)) return null;

  try {
    const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=20&api_key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) return null;
    const body = await res.json();

    const candidates = (body?.data?.emails || [])
      .map(e => ({ email: (e.value || '').toLowerCase(), score: e.confidence ?? 0, dept: e.department || '' }))
      .filter(e => e.email && isUsable(e.email));
    if (!candidates.length) return null;

    // Prefer an HR/recruiting mailbox, then Hunter's own confidence score.
    candidates.sort((a, b) => {
      const aHr = scoreEmail(a.email) + (/hr|recruit|people/i.test(a.dept) ? 2 : 0);
      const bHr = scoreEmail(b.email) + (/hr|recruit|people/i.test(b.dept) ? 2 : 0);
      if (aHr !== bHr) return bHr - aHr;
      return b.score - a.score;
    });

    const best = candidates[0];
    const confidence = best.score >= 80 ? 'high' : best.score >= 50 ? 'medium' : 'low';
    return { email: best.email, confidence, source: 'hunter' };
  } catch {
    return null;
  }
}

// ── 2. Startup / agency directories ──────────────────────────────────────────
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// Extensions that false-positive against the email regex inside inlined assets.
const ASSET_TLDS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'css', 'js', 'mjs', 'json', 'woff', 'woff2', 'ico'];

function extractEmails(html) {
  return [...new Set((html.match(EMAIL_RE) || []).map(e => e.toLowerCase()))]
    .filter(e => !ASSET_TLDS.includes(e.split('.').pop()))
    .filter(isUsable);
}

// Deliberately empty. The company-email-scraper repo this ports targeted
// Seedtable and Clutch, and neither is reachable this way any more (verified
// 2026-07-25):
//   • clutch.co serves a Cloudflare managed challenge on every path — even
//     /robots.txt returns the "Just a moment..." interstitial. Getting past it
//     means defeating a bot challenge, which we don't do.
//   • seedtable.com returns 403 on content pages regardless of user-agent, and
//     its robots.txt declares `Content-Signal: use=reference` (harvesting
//     addresses for outreach isn't reference use) and disallows several
//     crawlers by name.
// The scraper below still works against any server-rendered listing page, so
// pass your own `pages` if you find a source that permits it. Left empty rather
// than shipping defaults that always return zero and look like a silent bug.
const DIRECTORY_PAGES = [];

// Returns [{ email, companyName, source }]. Directory pages don't reliably
// pair an email with a company name in scrapeable markup, so the email's own
// domain becomes the company label — good enough for outreach, and honest
// about what we actually know.
export async function scrapeDirectories({ pages = DIRECTORY_PAGES, onProgress = () => {} } = {}) {
  const found = new Map();

  for (const page of pages) {
    try {
      const res = await fetch(page.url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
        redirect: 'follow',
      });
      if (!res.ok) {
        onProgress(`○ ${page.name} ${page.url.split('/').pop()}: HTTP ${res.status}`);
        continue;
      }
      const html = await res.text();
      const emails = extractEmails(html);
      let added = 0;
      for (const email of emails) {
        if (found.has(email)) continue;
        const domain = email.split('@')[1];
        found.set(email, {
          email,
          companyName: domain.split('.')[0].replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          source: `directory:${page.name.toLowerCase()}`,
        });
        added++;
      }
      onProgress(`${added ? '✓' : '○'} ${page.name}: ${added} email(s) from ${page.url.split('/').pop()}`);
    } catch (e) {
      onProgress(`⚠ ${page.name}: ${e.message.slice(0, 60)}`);
    }
    await new Promise(r => setTimeout(r, 800));
  }

  return Array.from(found.values());
}

export { DIRECTORY_PAGES };
