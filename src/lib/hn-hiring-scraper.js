// Scrapes the latest monthly Hacker News "Who is hiring?" thread (via
// Algolia's HN Search API, no scraping/HTML parsing needed) for companies
// that posted a direct contact email in their listing. Unlike
// outreach-discovery.js — which infers a contact by crawling a company's own
// site — these are addresses the poster deliberately published for people to
// reach out to, so personal-provider addresses (a founder's own Gmail, common
// for small startups posting here) are kept rather than filtered as junk.

// Filtered to the official "whoishiring" bot account, not a free-text query —
// a text search for "who is hiring" also matches unrelated submissions like
// "Ask HN: Who is hiring freelance developers?" or unrelated "who is X" posts
// that happen to rank as more recent than the actual monthly thread.
const SEARCH_API = 'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring';
const ITEM_API = 'https://hn.algolia.com/api/v1/items';
const FETCH_TIMEOUT = 15000;

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// HN's "Who is hiring?" threads occasionally get individual candidates
// posting themselves (in the wrong thread — "Who wants to be hired?" is a
// separate monthly thread) rather than a company describing an open role.
// The distinguishing signal is the post's OPENING words: a company says
// "X is looking for a developer" / "We're hiring a designer" (role-first),
// while a candidate leads with "SEEKING ..." / "Looking for work" about
// themselves. Checking only the first ~20 chars avoids false-positiving on
// "Foo is looking for a CTO", which contains "looking for" much later.
const JOB_SEEKER_OPENER = /^(seeking( work| a role| opportunities)?\b|looking for (work|a job|remote work)\b|available for hire\b|open to work\b)/i;
const JUNK_LOCAL = ['noreply', 'no-reply', 'donotreply', 'example'];
const JUNK_DOMAINS = ['example.com', 'sentry.io', 'schema.org', 'w3.org'];
// Asset/code-snippet extensions that regularly false-positive-match the email
// regex when a comment includes inline code (e.g. "app@1.0.0.tar.gz").
const JUNK_TLD_LOOKALIKES = ['mjs', 'js', 'css', 'map', 'json', 'woff', 'woff2', 'ttf', 'py', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'gz', 'tar'];

function isJunkEmail(email) {
  const [local, domain] = email.toLowerCase().split('@');
  if (!domain) return true;
  if (JUNK_LOCAL.some(j => local.includes(j))) return true;
  if (JUNK_DOMAINS.includes(domain)) return true;
  const tld = domain.split('.').pop();
  if (JUNK_TLD_LOOKALIKES.includes(tld)) return true;
  if (domain.split('.').every(seg => /^\d+$/.test(seg))) return true; // version-string false positive
  return false;
}

function stripHtml(html) {
  return (html || '')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>.*?<\/a>/gi, '$1')
    .replace(/<[^>]+>/g, ' ')
    // Numeric entities first (HN escapes "/" as &#x2F;, which the named-entity
    // list below never covered — that garbage used to leak straight into
    // outreach email subject lines via extractCompanyName's raw-text fallback).
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// A pipe-delimited first field only "looks like" a company name if it's
// short and doesn't read as a sentence — rejects free-form posts that never
// used the ' | ' convention at all (so the "first field" is the whole first
// sentence) instead of accepting anything under an 80-char ceiling, which is
// how prose like "I'm hiring flutter developers (or interested in..." used to
// pass through and land verbatim in a real outreach email's subject line.
function looksLikeCompanyName(candidate) {
  if (!candidate) return false;
  if (candidate.length > 50) return false;
  if (/^(i'm|i am|we're|we are|looking for|seeking|hiring)\b/i.test(candidate)) return false;
  if (/https?:\/\//i.test(candidate)) return false;
  if (/[.!?]$/.test(candidate)) return false; // sentences end in punctuation, names don't
  return true;
}

// "www.integrate.com" -> "Integrate"
function nameFromDomain(host) {
  if (!host) return null;
  const label = host.replace(/^www\./i, '').split('.')[0];
  if (!label) return null;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// HN "who is hiring" listings conventionally lead with the company name, e.g.
// "Acme Corp | Remote | Full-time | https://acme.com". When a post doesn't
// follow that convention, derive a name from the company's own domain
// (first from a URL in the post, then from the contact email itself) instead
// of falling back to a raw, possibly mid-word-truncated text slice.
function extractCompanyName(text, email) {
  const firstField = (text.split(/ \| /)[0] || '').trim();
  if (looksLikeCompanyName(firstField)) return firstField;

  const urlMatch = text.match(/https?:\/\/([^\s/]+)/i);
  const fromUrl = nameFromDomain(urlMatch?.[1]);
  if (fromUrl) return fromUrl;

  const fromEmail = nameFromDomain((email || '').split('@')[1]);
  if (fromEmail) return fromEmail;

  return "HN Who's Hiring contact";
}

// Best-effort region classification — not a geo database, just keyword
// matching. HN listing formats aren't consistent enough to rely on a fixed
// pipe-field position for location (some posters put it 2nd, some 3rd, some
// skip it entirely and put the role there instead) — so this scans the WHOLE
// listing text for region signals rather than guessing a single field index.
const US_HINTS = /\b(usa|u\.s\.a?\.?|united states|san francisco|new york|nyc|seattle|austin|boston|chicago|los angeles|denver|remote \(?us\)?|\b(ca|ny|wa|tx|ma|il|co|fl|ga|nc|va|oh|pa|az|mi|nj)\b)/i;
const EUROPE_HINTS = /\b(uk|united kingdom|london|england|germany|berlin|munich|france|paris|netherlands|amsterdam|spain|madrid|barcelona|italy|milan|sweden|stockholm|switzerland|zurich|ireland|dublin|portugal|lisbon|poland|warsaw|europe|eu\b|remote \(?eu\)?)/i;
// A pipe-delimited field "looks like" a location if it matches a region hint
// or the common "City, ST"/"City, Country" shape — used only to pick which
// field to show as the display location, not for region classification.
const LOOKS_LIKE_LOCATION = /remote|^[A-Z][a-z]+(?:[ .][A-Z][a-z]+)*,\s*[A-Z]{2,}$/;

function extractLocationAndRegion(text) {
  let region = 'other';
  if (US_HINTS.test(text)) region = 'us';
  else if (EUROPE_HINTS.test(text)) region = 'europe';
  else if (/\bremote\b/i.test(text)) region = 'remote';

  const parts = text.split(/ \| /).map(s => s.trim());
  const locationField = parts.slice(1, 4).find(p => LOOKS_LIKE_LOCATION.test(p) || US_HINTS.test(p) || EUROPE_HINTS.test(p))
    || (parts.length > 1 ? parts[1] : '');
  return { location: locationField.slice(0, 80) || null, region };
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) throw new Error(`HN API ${res.status} for ${url}`);
  return res.json();
}

// Returns up to `count` monthly "Who is hiring?" threads, most recent first.
// The bot account also posts "Who wants to be hired?" and "Freelancer? Seeking
// freelancer?" on the same schedule, so a single page of results (Algolia's
// default hitsPerPage) often contains too few actual "who is hiring" matches —
// paginate until we have enough or run out of pages.
const HITS_PER_PAGE = 50;
const MAX_PAGES = 10; // covers ~500 stories across all 3 monthly thread types

async function findRecentThreadIds(count) {
  const matches = [];
  for (let page = 0; page < MAX_PAGES && matches.length < count; page++) {
    const data = await fetchJson(`${SEARCH_API}&hitsPerPage=${HITS_PER_PAGE}&page=${page}`);
    const hits = data.hits || [];
    for (const h of hits) {
      if (/^ask hn:\s*who is hiring/i.test(h.title || '')) {
        matches.push({ id: h.objectID, title: h.title });
      }
    }
    if (page + 1 >= (data.nbPages || 1)) break;
  }
  return matches.slice(0, count);
}

async function scrapeThread(thread) {
  const item = await fetchJson(`${ITEM_API}/${thread.id}`);
  const topLevelComments = (item.children || []).filter(c => c && !c.dead && !c.deleted && c.text);

  const contacts = [];
  for (const comment of topLevelComments) {
    const text = stripHtml(comment.text);
    if (JOB_SEEKER_OPENER.test(text)) continue; // candidate post, not a company
    const email = [...text.matchAll(EMAIL_RE)].map(m => m[0].toLowerCase()).find(e => !isJunkEmail(e));
    if (!email) continue;
    const { location, region } = extractLocationAndRegion(text);
    contacts.push({ companyName: extractCompanyName(text, email), email, location, region, threadTitle: thread.title });
  }
  return contacts;
}

// Returns { threadTitle, contacts } for just the latest thread — kept for
// backwards compatibility with existing callers.
export async function scrapeLatestWhoIsHiringThread() {
  const [thread] = await findRecentThreadIds(1);
  if (!thread) return { threadTitle: null, contacts: [] };
  const contacts = await scrapeThread(thread);
  return { threadTitle: thread.title, contacts };
}

// Returns { threads: [{title}], contacts: [{ companyName, email, location, region, threadTitle }] }
// across the last `monthsBack` monthly threads (default 6) — one contact per
// top-level comment with a plausible email, de-duplicated by email across ALL
// threads combined (so re-running months later doesn't re-surface the same
// still-open listing under a different month).
export async function scrapeRecentWhoIsHiringThreads(monthsBack = 6) {
  const threads = await findRecentThreadIds(monthsBack);
  const seen = new Set();
  const contacts = [];
  for (const thread of threads) {
    const threadContacts = await scrapeThread(thread).catch(() => []);
    for (const c of threadContacts) {
      if (seen.has(c.email)) continue;
      seen.add(c.email);
      contacts.push(c);
    }
  }
  return { threads: threads.map(t => t.title), contacts };
}
