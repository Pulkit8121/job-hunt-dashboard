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
    .replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// HN "who is hiring" listings conventionally lead with the company name, e.g.
// "Acme Corp | Remote | Full-time | https://acme.com" — take the text up to
// the first pipe/newline as a best-effort company name. Falls back to a
// truncated snippet of the comment when that heuristic doesn't apply.
function extractCompanyName(text) {
  const firstLine = (text.split(/ \| /)[0] || '').trim();
  if (firstLine && firstLine.length <= 80) return firstLine;
  const snippet = text.slice(0, 60).trim();
  return snippet || "HN Who's Hiring contact";
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) throw new Error(`HN API ${res.status} for ${url}`);
  return res.json();
}

async function findLatestThreadId() {
  const data = await fetchJson(SEARCH_API);
  const thread = (data.hits || []).find(h => /^ask hn:\s*who is hiring/i.test(h.title || ''));
  return thread ? { id: thread.objectID, title: thread.title } : null;
}

// Returns { threadTitle, contacts: [{ companyName, email }] } — one contact
// per top-level comment that contains a plausible email (replies/questions
// nested under a listing are ignored, only the original poster's own comment
// counts). Emails are de-duplicated across the whole thread.
export async function scrapeLatestWhoIsHiringThread() {
  const thread = await findLatestThreadId();
  if (!thread) return { threadTitle: null, contacts: [] };

  const item = await fetchJson(`${ITEM_API}/${thread.id}`);
  const topLevelComments = (item.children || []).filter(c => c && !c.dead && !c.deleted && c.text);

  const seen = new Set();
  const contacts = [];
  for (const comment of topLevelComments) {
    const text = stripHtml(comment.text);
    const email = [...text.matchAll(EMAIL_RE)].map(m => m[0].toLowerCase()).find(e => !isJunkEmail(e));
    if (!email || seen.has(email)) continue;
    seen.add(email);
    contacts.push({ companyName: extractCompanyName(text), email });
  }

  return { threadTitle: thread.title, contacts };
}
