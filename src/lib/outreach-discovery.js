// Finds a public HR/careers contact email per company by checking the
// company's own careers page (or looking up its site via DuckDuckGo when we
// don't already have a URL), then probing a few common pages for a mailto
// link or plain-text email address. One best contact per company — not a
// scrape of every address on the page.

import { isExcludedOutreachDomain } from './exclusions.js';

const UA = 'Mozilla/5.0 (compatible; JobHuntBot/1.0; personal job-search tool)';
const FETCH_TIMEOUT = 8000;

const PRIORITY_PREFIXES = ['careers', 'career', 'hr', 'talent', 'recruit', 'recruiting', 'jobs', 'hiring'];
const JUNK_DOMAINS = ['sentry.io', 'wixpress.com', 'schema.org', 'example.com', 'godaddy.com', 'cloudflare.com', 'w3.org', 'google-analytics.com', 'gstatic.com', 'githubusercontent.com'];
const JUNK_LOCAL = ['noreply', 'no-reply', 'donotreply', 'webmaster', 'privacy', 'legal', 'abuse', 'support', 'unsubscribe'];

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const MAILTO_RE = /mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

function isJunkEmail(email) {
  const [local, domain] = email.toLowerCase().split('@');
  if (!domain) return true;
  if (JUNK_DOMAINS.some(d => domain.endsWith(d))) return true;
  if (JUNK_LOCAL.some(j => local.includes(j))) return true;
  if (/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(email)) return true;
  return false;
}

function rankEmails(emails) {
  const unique = [...new Set(emails.map(e => e.toLowerCase()))].filter(e => !isJunkEmail(e));
  unique.sort((a, b) => {
    const aPriority = PRIORITY_PREFIXES.some(p => a.startsWith(p)) ? 0 : 1;
    const bPriority = PRIORITY_PREFIXES.some(p => b.startsWith(p)) ? 0 : 1;
    return aPriority - bPriority;
  });
  return unique;
}

async function safeFetch(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text')) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function extractEmailsFromHtml(html) {
  const mailtos = [...html.matchAll(MAILTO_RE)].map(m => m[1]);
  const plain = [...html.matchAll(EMAIL_RE)].map(m => m[0]);
  return { mailtos, plain };
}

async function findCompanyHomepage(companyName) {
  const query = encodeURIComponent(`${companyName} careers page official site`);
  const html = await safeFetch(`https://html.duckduckgo.com/html/?q=${query}`);
  if (!html) return null;

  const linkMatch = html.match(/class="result__a"[^>]*href="([^"]+)"/);
  if (!linkMatch) return null;

  let href = linkMatch[1];
  const uddgMatch = href.match(/uddg=([^&]+)/);
  if (uddgMatch) href = decodeURIComponent(uddgMatch[1]);

  try {
    const url = new URL(href);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

function candidatePaths(baseUrl) {
  const origin = (() => {
    try { return new URL(baseUrl).origin; } catch { return null; }
  })();
  if (!origin) return [];
  return [baseUrl, `${origin}/careers`, `${origin}/contact`, `${origin}/contact-us`, `${origin}/about`, `${origin}/jobs`];
}

// Returns { email, source, confidence } or null.
export async function findContactForCompany(company) {
  if (isExcludedOutreachDomain(company.careersUrl)) return null;

  let baseUrl = company.careersUrl || null;
  let source = 'careers-page';

  if (!baseUrl) {
    baseUrl = await findCompanyHomepage(company.name);
    source = 'search';
  }
  if (!baseUrl || isExcludedOutreachDomain(baseUrl)) return null;

  const paths = candidatePaths(baseUrl);
  const foundMailtos = [];
  const foundPlain = [];

  for (const url of paths) {
    const html = await safeFetch(url);
    if (!html) continue;
    const { mailtos, plain } = extractEmailsFromHtml(html);
    foundMailtos.push(...mailtos);
    foundPlain.push(...plain);
    if (foundMailtos.length) break; // mailto link is a strong enough signal — stop early
  }

  const rankedMailtos = rankEmails(foundMailtos).filter(e => !isExcludedOutreachDomain(e));
  if (rankedMailtos.length) {
    return { email: rankedMailtos[0], source, confidence: 'high' };
  }

  const rankedPlain = rankEmails(foundPlain).filter(e => !isExcludedOutreachDomain(e));
  if (rankedPlain.length) {
    const priority = PRIORITY_PREFIXES.some(p => rankedPlain[0].startsWith(p));
    return { email: rankedPlain[0], source, confidence: priority ? 'medium' : 'low' };
  }

  return null;
}
