// Job discovery for the company-portal apply agent. Greenhouse/Lever reuse
// the existing fetchers in scraper.js (same public JSON APIs, no duplication).
// Ashby and Workday are new here since neither the Naukri-focused pipeline nor
// scraper.js supported them before.
import { scrapeGreenhouse, scrapeLever } from './scraper.js';
import { isRelevantJob, isRelevantJobBroad } from './matcher.js';

// The company-portal flow is the volume channel, so it uses the broad role
// matcher by default: measured on 2,060 live Greenhouse postings, the narrow
// PROFILE.roleKeywords list matched 6.7% of titles, which caps throughput far
// below target. Set PORTAL_BROAD_ROLES=false to fall back to the narrow list.
const relevant = (title) =>
  process.env.PORTAL_BROAD_ROLES === 'false' ? isRelevantJob(title) : isRelevantJobBroad(title);

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
      .filter(j => relevant(j.title))
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
      .filter(j => relevant(j.name))
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

// ── Workable / Recruitee / Breezy / Teamtailor ──────────────────────────────
// Four more platforms with fully public job APIs whose apply forms were each
// verified fillable under headless Chrome (real fields, a file input, and a
// reachable submit). Together they add 8,280 companies to the ~11,900 already
// covered by Greenhouse/Lever/Ashby.
//
// Two platforms were tested and deliberately left as discovery-only, since a
// driver for them would only manufacture skip records: JazzHR and Personio
// both render a real form but expose no reachable submit control even after
// dismissing their consent banner and scrolling — their submit appears to live
// inside an embedded frame.

export async function scrapeWorkable(slug) {
  try {
    const res = await fetch(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.jobs || [])
      .filter(j => relevant(j.title))
      .slice(0, 80)
      .map(j => ({
        title: j.title,
        jobId: j.shortcode,
        // application_url lands directly on the form, skipping a page load.
        link: j.application_url || `${j.url}/apply`,
        location: [j.city, j.country].filter(Boolean).join(', ') || (j.telecommuting ? 'Remote' : 'Unknown'),
        description: '',
        source: 'careers-page',
        atsType: 'workable',
        postedDate: j.published_on || today(),
      }));
  } catch {
    return [];
  }
}

export async function scrapeRecruitee(slug) {
  try {
    const res = await fetch(`https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.offers || [])
      .filter(j => relevant(j.title))
      .slice(0, 80)
      .map(j => ({
        title: j.title,
        jobId: String(j.id ?? j.slug ?? ''),
        link: j.careers_apply_url || j.careers_url,
        location: j.location || [j.city, j.country].filter(Boolean).join(', ') || 'Unknown',
        description: stripHtml(j.description || '').slice(0, 600),
        source: 'careers-page',
        atsType: 'recruitee',
        postedDate: (j.created_at || '').split(' ')[0] || today(),
      }));
  } catch {
    return [];
  }
}

export async function scrapeBreezy(slug) {
  try {
    const res = await fetch(`https://${encodeURIComponent(slug)}.breezy.hr/json/`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data
      .filter(j => relevant(j.name))
      .slice(0, 80)
      .map(j => ({
        title: j.name,
        jobId: j.id,
        link: `${j.url}/apply`,
        location: [j.location?.city, j.location?.country?.name].filter(Boolean).join(', ') || 'Unknown',
        description: '',
        source: 'careers-page',
        atsType: 'breezy',
        postedDate: (j.published_date || '').split('T')[0] || today(),
      }));
  } catch {
    return [];
  }
}

export async function scrapeTeamtailor(slug) {
  try {
    // Teamtailor publishes a JSON Feed rather than a bespoke API.
    const res = await fetch(`https://${encodeURIComponent(slug)}.teamtailor.com/jobs.json`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items || [])
      .filter(j => relevant(j.title))
      .slice(0, 80)
      .map(j => ({
        title: j.title,
        jobId: j.id,
        link: j.url,
        location: j.location || 'Unknown',
        description: stripHtml(j.content_html || '').slice(0, 600),
        source: 'careers-page',
        atsType: 'teamtailor',
        postedDate: (j.date_published || '').split('T')[0] || today(),
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
      .filter(j => relevant(j.title))
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
  { atsType: 'workable', re: /apply\.workable\.com\/([a-z0-9_-]+)/i },
  { atsType: 'recruitee', re: /([a-z0-9_-]+)\.recruitee\.com/i },
  { atsType: 'breezy', re: /([a-z0-9_-]+)\.breezy\.hr/i },
  { atsType: 'teamtailor', re: /([a-z0-9_-]+)\.teamtailor\.com/i },
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
  if (company.atsType === 'workable' && company.atsSlug) return scrapeWorkable(company.atsSlug);
  if (company.atsType === 'recruitee' && company.atsSlug) return scrapeRecruitee(company.atsSlug);
  if (company.atsType === 'breezy' && company.atsSlug) return scrapeBreezy(company.atsSlug);
  if (company.atsType === 'teamtailor' && company.atsSlug) return scrapeTeamtailor(company.atsSlug);
  if (company.atsType === 'workday' && company.careersUrl) {
    return scrapeWorkdayListings(company.careersUrl);
  }
  return [];
}
