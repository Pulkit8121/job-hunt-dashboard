// Finds which ATS a company's careers page runs on, and VERIFIES the board
// actually belongs to that company before tagging it.
//
// Verification is the whole point. The seed data had Porter (an Indian
// logistics startup) tagged with Lever slug "porter", which is really an
// unrelated US healthcare company — so the apply agent went off and tried to
// submit an application for "Nurse Practitioner, Grand Rapids". A slug that
// merely *resolves* proves nothing; it has to resolve to the right company.
//
// Lever and Ashby are prioritised over Greenhouse because Greenhouse job pages
// sit behind an invisible reCAPTCHA that our automation correctly refuses to
// work around, so a Greenhouse tag yields discoverable-but-unappliable jobs.
import { scrapeGreenhouse, scrapeLever } from './scraper.js';
import { scrapeAshby } from './company-portal-discovery.js';

const UA = 'Mozilla/5.0 (compatible; JobHuntBot/1.0; personal job-search tool)';
const TIMEOUT = 12000;

const GENERIC_WORDS = /\b(technologies|technology|solutions|solution|consulting|consultancy|systems|system|services|service|labs|lab|software|infotech|pvt|private|ltd|limited|inc|llc|india|global|group|corp|corporation|co|international|enterprises|the)\b/g;

function normalize(str = '') {
  return str.toLowerCase().replace(GENERIC_WORDS, '').replace(/[^a-z0-9]/g, '');
}

// Candidate slugs, most-likely first. Keep this small — every candidate is a
// network call against a third party.
export function slugCandidates(name = '') {
  const base = name.toLowerCase().trim();
  const noSuffix = base.replace(GENERIC_WORDS, ' ').replace(/\s+/g, ' ').trim();
  const out = new Set();
  const add = (s) => { const v = s.replace(/[^a-z0-9-]/g, ''); if (v.length >= 3) out.add(v); };

  add(noSuffix.replace(/\s+/g, ''));
  add(noSuffix.replace(/\s+/g, '-'));
  add(base.replace(/\s+/g, ''));
  add(base.replace(/\s+/g, '-'));
  add(noSuffix.split(' ')[0] || '');
  return Array.from(out).slice(0, 5);
}

// Does this board plausibly belong to `companyName`?
// Checks the board's own advertised name, falling back to the public board
// page's <title>. Returns true only on a real name overlap.
async function boardBelongsTo(atsType, slug, companyName) {
  const want = normalize(companyName);
  if (want.length < 3) return false;

  const nameMatches = (candidate) => {
    const got = normalize(candidate || '');
    if (!got || got.length < 3) return false;
    if (got === want) return true;
    const [shorter, longer] = got.length <= want.length ? [got, want] : [want, got];
    return longer.includes(shorter) && shorter.length / longer.length >= 0.6;
  };

  // Greenhouse advertises the board's display name directly.
  if (atsType === 'greenhouse') {
    try {
      const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}`, { signal: AbortSignal.timeout(TIMEOUT) });
      if (res.ok) {
        const body = await res.json();
        if (nameMatches(body?.name)) return true;
      }
    } catch {}
  }

  // Otherwise (and as a Greenhouse fallback) read the public board page title.
  const pageUrl = atsType === 'lever' ? `https://jobs.lever.co/${slug}`
    : atsType === 'ashby' ? `https://jobs.ashbyhq.com/${slug}`
    : `https://job-boards.greenhouse.io/${slug}`;
  try {
    const res = await fetch(pageUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) return false;
    const html = await res.text();
    const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '';
    const og = html.match(/property=["']og:site_name["'][^>]*content=["']([^"']+)/i)?.[1] || '';
    return nameMatches(title) || nameMatches(og);
  } catch {
    return false;
  }
}

// Board-existence probes. Deliberately UNfiltered: the role-relevance
// filters in scraper.js answer "are there jobs for me right now", which is a
// different question from "does this company have a board here". Using the
// filtered fetchers made detection miss real boards (CRED, Hasura, Meesho)
// simply because they had no matching openings on the day we looked.
const PROBES = {
  lever: async (slug) => {
    const res = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) return 0;
    const data = await res.json();
    return Array.isArray(data) ? data.length : 0;
  },
  ashby: async (slug) => {
    const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) return 0;
    const data = await res.json();
    return (data?.jobs || []).length;
  },
  greenhouse: async (slug) => {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, { signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) return 0;
    const data = await res.json();
    return (data?.jobs || []).length;
  },
};

// Kept for callers that want the role-filtered counts after detection.
const FETCHERS = {
  lever: scrapeLever,
  ashby: scrapeAshby,
  greenhouse: scrapeGreenhouse,
};

// Returns { atsType, atsSlug, jobCount } or null.
// Order matters: Lever/Ashby first because those are actually appliable.
export async function detectAtsForCompany(company, { order = ['lever', 'ashby', 'greenhouse'] } = {}) {
  const name = company.name || '';
  const candidates = slugCandidates(name);
  if (!candidates.length) return null;

  for (const atsType of order) {
    const probe = PROBES[atsType];
    for (const slug of candidates) {
      let total = 0;
      try {
        total = await probe(slug);
      } catch {
        continue;
      }
      if (!total) continue; // no such board (or an empty one — nothing to apply to either way)

      const verified = await boardBelongsTo(atsType, slug, name);
      if (!verified) continue;

      // How many are actually relevant to this profile right now.
      let relevant = 0;
      try {
        relevant = (await FETCHERS[atsType](slug))?.length || 0;
      } catch {}

      return { atsType, atsSlug: slug, jobCount: total, relevantCount: relevant };
    }
  }
  return null;
}
