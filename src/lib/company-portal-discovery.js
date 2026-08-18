// Job discovery for the company-portal apply agent. Greenhouse/Lever reuse
// the existing fetchers in scraper.js (same public JSON APIs, no duplication).
// Ashby and Workday are new here since neither the Naukri-focused pipeline nor
// scraper.js supported them before.
import { scrapeGreenhouse, scrapeLever } from './scraper.js';
import { isRelevantJob } from './matcher.js';

const FETCH_TIMEOUT = 15000;

function stripHtml(html = '') {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function today() {
  return new Date().toISOString().split('T')[0];
}

// ── Ashby public job-board API (no browser needed) ──────────────────────────
export async function scrapeAshby(slug) {
  try {
    const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.jobs || [])
      .filter(j => isRelevantJob(j.title))
      .slice(0, 80)
      .map(j => ({
        title: j.title,
        jobId: j.id,
        link: j.jobUrl || j.applyUrl,
        location: j.location || j.address?.postalAddress?.addressLocality || 'Remote',
        description: stripHtml(j.descriptionPlain || '').slice(0, 600),
        source: 'careers-page',
        atsType: 'ashby',
        postedDate: j.publishedAt ? j.publishedAt.split('T')[0] : today(),
      }));
  } catch {
    return [];
  }
}

// ── SmartRecruiters public postings API ─────────────────────────────────────
// Added because Greenhouse/Lever/Ashby alone covered only 414 of the 5,763
// tracked companies. SmartRecruiters is the next-largest board with a fully
// public, unauthenticated postings API and an ordinary HTML application form,
// so it slots into the existing generic filler with no new apply logic.
//
// Workable and Recruitee were evaluated alongside it and deliberately left
// out: their public endpoints respond, but every board probed returned an
// empty job list, so a driver for them would be untestable guesswork.
export async function scrapeSmartRecruiters(slug) {
  try {
    const res = await fetch(
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=100`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.content || [])
      .filter(j => isRelevantJob(j.name))
      .slice(0, 80)
      .map(j => ({
        title: j.name,
        jobId: j.id,
        // The canonical public posting page; the apply form is behind its
        // Apply control, which ensureApplyForm() already knows how to reach.
        link: `https://jobs.smartrecruiters.com/${slug}/${j.id}`,
        location: j.location?.fullLocation
          || [j.location?.city, j.location?.country].filter(Boolean).join(', ')
          || 'Unknown',
        description: '',
        source: 'careers-page',
        atsType: 'smartrecruiters',
        postedDate: j.releasedDate ? j.releasedDate.split('T')[0] : today(),
      }));
  } catch {
    return [];
  }
}

// ── Workday CXS job-listing API — discovery only, no auto-submit (see
// company-portal-apply route for why). Workday tenant URLs look like
// https://{tenant}.wd1.myworkdayjobs.com/{site}, and the same page's own
// frontend calls a matching /wday/cxs/{tenant}/{site}/jobs POST endpoint —
// we reuse that endpoint since the tenant/site are already in the URL path.
const WORKDAY_URL_RE = /https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z0-9_-]+\/)?([a-z0-9_-]+)/i;

export function parseWorkdayTenant(url = '') {
  const m = url.match(WORKDAY_URL_RE);
  if (!m) return null;
  return { tenant: m[1], wd: m[2], site: m[3] };
}

export async function scrapeWorkdayListings(careersUrl) {
  const parsed = parseWorkdayTenant(careersUrl);
  if (!parsed) return [];
  const { tenant, wd, site } = parsed;
  const endpoint = `https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: 80, offset: 0, searchText: '' }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.jobPostings || [])
      .filter(j => isRelevantJob(j.title))
      .map(j => ({
        title: j.title,
        jobId: j.bulletFields?.[0] || j.externalPath,
        link: `https://${tenant}.${wd}.myworkdayjobs.com/${site}${j.externalPath}`,
        location: j.locationsText || 'Unknown',
        description: '',
        source: 'careers-page',
        atsType: 'workday',
        postedDate: today(),
      }));
  } catch {
    return [];
  }
}

// ── ATS auto-detection ───────────────────────────────────────────────────────
// Signature domains a company's careers URL resolves to (directly, or after a
// redirect) — lets us backfill atsType/atsSlug for companies that already
// have a careersUrl but weren't tagged with a specific ATS yet, growing
// coverage automatically as more companies get tracked instead of relying on
// a hand-maintained global list.
const ATS_SIGNATURES = [
  { atsType: 'greenhouse', re: /(?:boards|job-boards)\.greenhouse\.io\/([a-z0-9_-]+)/i },
  { atsType: 'lever', re: /jobs\.lever\.co\/([a-z0-9_-]+)/i },
  { atsType: 'ashby', re: /jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i },
  { atsType: 'smartrecruiters', re: /jobs\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/i },
  { atsType: 'workday', re: WORKDAY_URL_RE },
];

export async function detectAtsFromUrl(url) {
  if (!url) return null;
  for (const sig of ATS_SIGNATURES) {
    const m = url.match(sig.re);
    if (m) return { atsType: sig.atsType, atsSlug: m[1] };
  }

  // Not an ATS URL itself — it might redirect to one (e.g. a company's own
  // careers page that embeds/forwards to Greenhouse).
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobHuntBot/1.0; personal job-search tool)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    const finalUrl = res.url || url;
    for (const sig of ATS_SIGNATURES) {
      const m = finalUrl.match(sig.re);
      if (m) return { atsType: sig.atsType, atsSlug: m[1] };
    }
  } catch {
    // ignore — leave atsType as-is
  }
  return null;
}

// Returns raw jobs (pre-eligibility-filter) for a company's known ATS, tagging
// atsType on each so the apply route knows which driver to use without
// re-detecting per job.
export async function discoverAtsJobs(company) {
  if (company.atsType === 'greenhouse' && company.atsSlug) {
    const jobs = await scrapeGreenhouse(company.atsSlug);
    return jobs.map(j => ({ ...j, atsType: 'greenhouse' }));
  }
  if (company.atsType === 'lever' && company.atsSlug) {
    const jobs = await scrapeLever(company.atsSlug);
    return jobs.map(j => ({ ...j, atsType: 'lever' }));
  }
  if (company.atsType === 'ashby' && company.atsSlug) {
    return scrapeAshby(company.atsSlug);
  }
  if (company.atsType === 'smartrecruiters' && company.atsSlug) {
    return scrapeSmartRecruiters(company.atsSlug);
  }
  if (company.atsType === 'workday' && company.careersUrl) {
    return scrapeWorkdayListings(company.careersUrl);
  }
  return [];
}
