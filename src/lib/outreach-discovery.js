// Finds a public HR/careers contact email per company by checking the
// company's own careers page (or looking up its site via Bing search when we
// don't already have a URL — DuckDuckGo's HTML endpoint blocks/drops requests
// from this server's IP entirely, confirmed by direct testing), then probing a
// few common pages for a mailto link or plain-text email address. One best
// contact per company — not a scrape of every address on the page.

import { isExcludedOutreachDomain } from './exclusions.js';

const UA = 'Mozilla/5.0 (compatible; JobHuntBot/1.0; personal job-search tool)';
const SEARCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 8000;

const PRIORITY_PREFIXES = ['careers', 'career', 'hr', 'talent', 'recruit', 'recruiting', 'jobs', 'hiring'];
const JUNK_DOMAINS = ['sentry.io', 'wixpress.com', 'schema.org', 'example.com', 'godaddy.com', 'cloudflare.com', 'w3.org', 'google-analytics.com', 'gstatic.com', 'githubusercontent.com'];
const JUNK_LOCAL = ['noreply', 'no-reply', 'donotreply', 'webmaster', 'privacy', 'legal', 'abuse', 'support', 'unsubscribe', 'test'];
// Asset/code file extensions that regularly false-positive-match the email
// regex (e.g. "react@19.1.0.mjs" from an inlined package.json/import map).
const JUNK_TLD_LOOKALIKES = ['mjs', 'js', 'css', 'map', 'json', 'woff', 'woff2', 'ttf', 'py', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'];
// Free personal-email providers aren't a verifiable company contact — almost
// always test/junk data left in a page's source, not a real HR address.
const PERSONAL_PROVIDERS = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'protonmail.com', 'icloud.com'];

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const MAILTO_RE = /mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

function isJunkEmail(email) {
  const [local, domain] = email.toLowerCase().split('@');
  if (!domain) return true;
  if (JUNK_DOMAINS.some(d => domain.endsWith(d))) return true;
  if (JUNK_LOCAL.some(j => local.includes(j))) return true;
  if (PERSONAL_PROVIDERS.includes(domain)) return true;
  const tld = domain.split('.').pop();
  if (JUNK_TLD_LOOKALIKES.includes(tld)) return true;
  // Reject domains that are purely numeric segments (version strings like "19.1.0")
  if (domain.split('.').every(seg => /^\d+$/.test(seg))) return true;
  return false;
}

// Only trust an email if its domain is the same site we're scraping (or a
// subdomain of it) — filters out unrelated third-party emails picked up from
// embedded widgets/scripts (e.g. an analytics vendor's contact address).
function isSameSite(email, pageOrigin) {
  try {
    const emailDomain = email.split('@')[1]?.toLowerCase();
    const siteDomain = new URL(pageOrigin).hostname.toLowerCase().replace(/^www\./, '');
    if (!emailDomain) return false;
    return emailDomain === siteDomain || emailDomain.endsWith(`.${siteDomain}`) || siteDomain.endsWith(`.${emailDomain}`);
  } catch {
    return false;
  }
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

function decodeBingRedirect(rawHref) {
  const href = rawHref.replace(/&amp;/g, '&'); // raw HTML source, not yet entity-decoded
  try {
    const url = new URL(href, 'https://www.bing.com');
    const u = url.searchParams.get('u');
    if (!u) return href; // not a redirect wrapper — already a direct link
    // Bing prefixes the base64-encoded target URL with a 2-char marker (e.g. "a1").
    const decoded = Buffer.from(u.slice(2), 'base64').toString('utf-8');
    return decoded.startsWith('http') ? decoded : href;
  } catch {
    return href;
  }
}

const GENERIC_NAME_WORDS = /\b(technologies|technology|solutions|solution|consulting|consultancy|consultants|engineering|systems|system|services|service|labs|lab|software|softwares|infotech|infosystems|pvt|ltd|limited|private|inc|llc|india|global|group|corp|corporation|co|international|enterprises|networks|network)\b/g;

function normalizeForMatch(str) {
  return (str || '')
    .toLowerCase()
    .replace(GENERIC_NAME_WORDS, '')
    .replace(/[^a-z0-9]/g, '');
}

// A search engine can return a confidently-formatted but totally unrelated top
// result for an obscure/small company name (e.g. "Altos Technologies" search
// resolving to delta.com). Require the resolved domain to actually share the
// company's core name — otherwise we'd be emailing a random unrelated company.
function domainMatchesCompany(companyName, homepageUrl) {
  try {
    const hostname = new URL(homepageUrl).hostname.toLowerCase().replace(/^www\./, '');
    const domainCore = hostname.split('.')[0];
    const nameCore = normalizeForMatch(companyName);
    if (!domainCore || !nameCore) return false;
    if (nameCore.length < 4 || domainCore.length < 4) return nameCore === domainCore;
    if (domainCore === nameCore) return true;
    // Substring containment alone lets a short, generic word falsely match —
    // e.g. "cloud" (from a "cloud.google.com" subdomain) is a substring of
    // "cloudanalogy" despite being an unrelated company. Require the shorter
    // string to cover most of the longer one, not just any fragment of it.
    const [shorter, longer] = domainCore.length <= nameCore.length ? [domainCore, nameCore] : [nameCore, domainCore];
    return longer.includes(shorter) && shorter.length / longer.length >= 0.5;
  } catch {
    return false;
  }
}

async function findCompanyHomepage(companyName) {
  const query = encodeURIComponent(`${companyName} careers page official site`);
  let html;
  try {
    const res = await fetch(`https://www.bing.com/search?q=${query}`, {
      headers: { 'User-Agent': SEARCH_UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }
  if (!html) return null;

  const linkMatch = html.match(/<h2[^>]*><a[^>]*href="([^"]+)"/);
  if (!linkMatch) return null;

  const href = decodeBingRedirect(linkMatch[1]);

  try {
    const url = new URL(href);
    const homepage = `${url.protocol}//${url.host}`;
    // Only trust this when we had to guess via search — a company-provided
    // careersUrl is already curated and doesn't need this check.
    if (!domainMatchesCompany(companyName, homepage)) return null;
    return homepage;
  } catch {
    return null;
  }
}

// Ordered so HR/careers-specific pages are checked before generic ones — a
// mailto found on /contact or the homepage is often a legal/sales/support
// address, whereas /careers, /jobs, /join-us are where an actual HR contact
// tends to live.
function candidatePaths(baseUrl) {
  const origin = (() => {
    try { return new URL(baseUrl).origin; } catch { return null; }
  })();
  if (!origin) return [];
  return [
    `${origin}/careers`,
    `${origin}/careers/contact`,
    `${origin}/jobs`,
    `${origin}/join-us`,
    `${origin}/work-with-us`,
    baseUrl,
    `${origin}/contact`,
    `${origin}/contact-us`,
    `${origin}/about`,
  ];
}

function isHrEmail(email) {
  return PRIORITY_PREFIXES.some(p => email.startsWith(p));
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
    // Stop as soon as we have a genuine HR-prefixed mailto — that's the best
    // possible signal and there's no reason to keep crawling. A generic
    // mailto (sales@, info@) is NOT enough to stop early — keep checking
    // remaining pages in case an HR-specific address turns up.
    if (foundMailtos.some(isHrEmail)) break;
  }

  const rankedMailtos = rankEmails(foundMailtos)
    .filter(e => !isExcludedOutreachDomain(e))
    .filter(e => isSameSite(e, baseUrl));
  if (rankedMailtos.length) {
    const confidence = isHrEmail(rankedMailtos[0]) ? 'high' : 'medium';
    return { email: rankedMailtos[0], source, confidence };
  }

  const rankedPlain = rankEmails(foundPlain)
    .filter(e => !isExcludedOutreachDomain(e))
    .filter(e => isSameSite(e, baseUrl));
  if (rankedPlain.length) {
    const confidence = isHrEmail(rankedPlain[0]) ? 'medium' : 'low';
    return { email: rankedPlain[0], source, confidence };
  }

  return null;
}
