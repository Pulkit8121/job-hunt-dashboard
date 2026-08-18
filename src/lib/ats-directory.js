// Sources the universe of ATS job boards, independent of the `companies`
// collection.
//
// The pipeline previously discovered boards the wrong way round: start from a
// tracked company, guess slug candidates, probe. With a company list that is
// overwhelmingly Indian firms with no ATS presence, that yielded 414 boards —
// and measurement showed 95% of live boards found by direct enumeration were
// ones the company-driven path had never seen.
//
// Two sources, both public and unauthenticated:
//
//   1. A curated directory published as plain CSV (name,slug,url) by the
//      ats-scrapers project — 6,031 Greenhouse + 3,448 Ashby + 2,402 Lever
//      boards. No harvesting required, so this is the default.
//   2. Wayback CDX archive enumeration, which is how the large aggregators
//      build their ~95,000-slug lists. Slower and rate-limited, but it finds
//      boards the curated list misses and is the path to a bigger universe.
//
// Neither source is trusted blind: a slug only counts once its board answers
// with real postings, which is verified in the sync route.

const DIRECTORY_BASE =
  process.env.ATS_DIRECTORY_BASE ||
  'https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies';

// Only the platforms the apply engine can actually submit to. Adding a file
// here without an apply driver just fills the queue with jobs that will be
// skipped.
export const DIRECTORY_FILES = {
  greenhouse: 'greenhouse.csv',
  lever: 'lever.csv',
  ashby: 'ashby.csv',
  // Added after verifying each one's apply form is fillable under headless
  // Chrome — real fields, a file input, and a reachable submit control.
  workable: 'workable.csv',
  recruitee: 'recruitee.csv',
  breezy: 'breezy.csv',
  teamtailor: 'teamtailor.csv',
};

const FETCH_TIMEOUT = 60000;

// Minimal CSV reader. These files are machine-generated with a fixed
// `name,slug,url` header, but company names legitimately contain commas
// ("Acme, Inc."), so quoted fields have to be handled or the slug column
// silently shifts.
export function parseCsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return rows;

  const splitLine = (line) => {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = !quoted;
      } else if (ch === ',' && !quoted) {
        out.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  };

  const header = splitLine(lines[0]).map(h => h.trim().toLowerCase());
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const row = {};
    header.forEach((h, idx) => { row[h] = (cells[idx] || '').trim(); });
    rows.push(row);
  }
  return rows;
}

// Slugs must survive being pasted into an API path. Anything with a slash,
// space or scheme in it is a parse artefact, not a board.
function validSlug(slug = '') {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{1,60}$/.test(slug);
}

// Returns [{ atsType, slug, name }] for one platform.
export async function fetchDirectory(atsType) {
  const file = DIRECTORY_FILES[atsType];
  if (!file) return [];

  const res = await fetch(`${DIRECTORY_BASE}/${file}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    headers: { 'User-Agent': 'JobHuntBot/1.0 (personal job-search tool)' },
  });
  if (!res.ok) throw new Error(`${atsType} directory fetch failed: HTTP ${res.status}`);

  const seen = new Set();
  const out = [];
  for (const row of parseCsv(await res.text())) {
    const slug = row.slug || '';
    if (!validSlug(slug) || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ atsType, slug, name: row.name || slug });
  }
  return out;
}

// ── Wayback CDX enumeration ─────────────────────────────────────────────────
// The archive index is keyed by URL, so asking for every capture under an ATS
// domain and reading the first path segment yields board slugs. Deliberately
// secondary to the curated directory: it is slow, aggressively rate-limited,
// and returns a long tail of dead boards — but it is the only route to the
// ~95k-slug universe the big aggregators run on.
const CDX_DOMAINS = {
  greenhouse: ['boards.greenhouse.io', 'job-boards.greenhouse.io'],
  lever: ['jobs.lever.co'],
  ashby: ['jobs.ashbyhq.com'],
};

const CDX_NOISE = new Set([
  'embed', 'jobs', 'api', 'assets', 'static', 'favicon.ico', 'robots.txt',
  'privacy', 'terms', 'search', 'error', 'index.html',
]);

export async function harvestFromCdx(atsType, { limit = 40000, onProgress = () => {} } = {}) {
  const domains = CDX_DOMAINS[atsType] || [];
  const slugs = new Set();

  for (const domain of domains) {
    const url = `http://web.archive.org/cdx/search/cdx?url=${domain}&matchType=domain`
      + `&output=text&fl=original&collapse=urlkey&filter=statuscode:200&limit=${limit}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
      if (!res.ok) { onProgress(`⚠ CDX ${domain}: HTTP ${res.status}`); continue; }
      const text = await res.text();
      for (const line of text.split('\n')) {
        const m = line.trim().match(/^https?:\/\/[^/]+\/([^/?#]+)/i);
        if (!m) continue;
        const slug = m[1].toLowerCase();
        if (!validSlug(slug) || CDX_NOISE.has(slug)) continue;
        slugs.add(slug);
      }
      onProgress(`  CDX ${domain}: ${slugs.size} slug(s) so far`);
    } catch (e) {
      onProgress(`⚠ CDX ${domain}: ${e.message.slice(0, 80)}`);
    }
  }

  return [...slugs].map(slug => ({ atsType, slug, name: slug }));
}

// ── Liveness probe ──────────────────────────────────────────────────────────
// A directory entry is a claim, not a fact. This is the same set of public
// endpoints the apply flow reads from, so a board that answers here is one the
// pipeline can genuinely use.
//
// Greenhouse tolerated 300 probes at 40-way concurrency with zero 429s;
// Ashby is the strict one, which is why callers throttle it separately.
const PROBES = {
  greenhouse: async (slug) => {
    const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    return ((await r.json())?.jobs || []).length;
  },
  lever: async (slug) => {
    const r = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d) ? d.length : null;
  },
  ashby: async (slug) => {
    const r = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    return ((await r.json())?.jobs || []).length;
  },
  workable: async (slug) => {
    const r = await fetch(`https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    return ((await r.json())?.jobs || []).length;
  },
  recruitee: async (slug) => {
    const r = await fetch(`https://${slug}.recruitee.com/api/offers/`, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    return ((await r.json())?.offers || []).length;
  },
  breezy: async (slug) => {
    const r = await fetch(`https://${slug}.breezy.hr/json/`, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    const d = await r.json();
    return Array.isArray(d) ? d.length : null;
  },
  teamtailor: async (slug) => {
    const r = await fetch(`https://${slug}.teamtailor.com/jobs.json`, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    return ((await r.json())?.items || []).length;
  },
};

// Returns the board's posting count, or null when it doesn't exist / is empty.
export async function probeBoard(atsType, slug) {
  const probe = PROBES[atsType];
  if (!probe) return null;
  try {
    return await probe(slug);
  } catch {
    return null;
  }
}

// Per-platform probe concurrency, matching what each API actually tolerates.
export const PROBE_CONCURRENCY = {
  greenhouse: Number(process.env.PROBE_CONCURRENCY_GREENHOUSE) || 30,
  lever: Number(process.env.PROBE_CONCURRENCY_LEVER) || 20,
  ashby: Number(process.env.PROBE_CONCURRENCY_ASHBY) || 5,
  // Workable is the most fragile of the seven. At 20-way the bulk probe marked
  // 4,014 of 4,268 boards dead; re-probing a sample of those serially showed
  // 35% of them actually had jobs. The failures were connection drops under
  // load rather than 429s, so the fix is fewer sockets, not backoff.
  workable: Number(process.env.PROBE_CONCURRENCY_WORKABLE) || 6,
  recruitee: Number(process.env.PROBE_CONCURRENCY_RECRUITEE) || 15,
  breezy: Number(process.env.PROBE_CONCURRENCY_BREEZY) || 15,
  teamtailor: Number(process.env.PROBE_CONCURRENCY_TEAMTAILOR) || 15,
};
