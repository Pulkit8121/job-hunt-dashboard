// Pre-flight a Naukri job against Naukri's own job-detail API before spending
// a browser page load (and a slot in the daily apply quota) on it.
//
// Why this exists — two measured failures it fixes:
//
//   1. "No Apply button found" was the single largest skip reason in the
//      database: 2,287 jobs. That was never a selector bug. Naukri stops
//      rendering an Apply button once a listing expires, and the pipeline was
//      queueing months-old scrapes. Confirmed directly against this endpoint:
//      a stored job from the queue answers {"metaSearch":{"isExpiredJob":"1"}}.
//      Detecting that from JSON costs one fetch instead of a 45s navigation.
//
//   2. "Apply on company website" jobs were dead-ending: 1,341 skipped that
//      way, but only 42 non-Naukri job links ever made it into the database.
//      captureExternalApplyUrl() has to click a JS-handler button and race the
//      navigation, and it almost never won. This API returns the redirect URL
//      as a plain field, so those listings become real company-portal
//      candidates instead of being thrown away.
//
// Called from INSIDE the page via page.evaluate so it inherits the logged-in
// session cookies and same-origin context — the endpoint answers "recaptcha
// required" to an anonymous request from Node, but is just the page's own
// backing API when the browser asks for it.

// Naukri's web client identifies itself with these; without them the endpoint
// 400s. Values read off the site's own XHRs.
const API_HEADERS = { appid: '121', systemid: '121' };

// A pre-flight must never be able to *cause* a failure — if Naukri changes the
// endpoint or the network hiccups, we return unknown and let the existing
// DOM-driven flow proceed exactly as before.
const UNKNOWN = { known: false, expired: false, externalUrl: null };

export function extractJobId(link = '') {
  // Naukri job URLs end in a numeric id: .../job-listings-<slug>-<12-digit-id>
  const m = link.split('?')[0].match(/(\d{9,})\/?$/);
  return m ? m[1] : null;
}

// Exported for unit-testing against captured payloads without a browser.
export function interpretJobDetail(payload) {
  if (!payload || typeof payload !== 'object') return UNKNOWN;

  if (String(payload?.metaSearch?.isExpiredJob) === '1') {
    return { known: true, expired: true, externalUrl: null };
  }

  const jd = payload.jobDetails || payload.jobDetail || {};
  // Naukri has shipped this under several names across versions; take the
  // first that looks like an off-site absolute URL rather than betting on one.
  const candidates = [
    jd.applyRedirectUrl, jd.applyUrl, jd.redirectUrl, jd.externalApplyUrl,
    jd.applyRedirectionUrl, payload.applyRedirectUrl,
  ];
  const externalUrl = candidates.find(
    u => typeof u === 'string' && /^https?:\/\//i.test(u) && !/naukri\.com/i.test(u)
  ) || null;

  // If the payload carried no jobDetails at all we learned nothing useful.
  if (!Object.keys(jd).length && !externalUrl) return UNKNOWN;

  return { known: true, expired: false, externalUrl };
}

// Returns { known, expired, externalUrl }. `known: false` means "no verdict —
// carry on with the normal flow".
export async function fetchJobDetail(page, link) {
  const jobId = extractJobId(link);
  if (!jobId) return UNKNOWN;

  const payload = await page.evaluate(async (id, headers) => {
    try {
      const res = await fetch(`https://www.naukri.com/jobapi/v4/job/${id}`, {
        headers,
        credentials: 'include',
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }, jobId, API_HEADERS).catch(() => null);

  return interpretJobDetail(payload);
}
