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
// Called from INSIDE the page via page.evaluate so it inherits the session
// cookies and same-origin context.
//
// IMPORTANT — measured limitation. Naukri gates this endpoint behind reCAPTCHA
// and returns 406 {"message":"recaptcha required"} to an anonymous browser
// session, verified against a real Chrome on www.naukri.com across four header
// permutations (the header format itself is correct: omitting appid/systemid
// gets a distinct 400 "provide the valid App Id and SystemId"). The one case
// that answers without the gate is an already-expired job, which is why an
// expiry check can still succeed where a full detail fetch cannot.
//
// Whether a logged-in server session clears the gate is unconfirmed. So this
// is written to be free when it doesn't work: after GATED_LIMIT consecutive
// gated responses it stops calling out for the rest of the process, and every
// failure mode returns "no verdict" so the normal DOM flow is untouched.

// Naukri's web client identifies itself with these; without them the endpoint
// 400s. Values read off the site's own XHRs.
const API_HEADERS = { appid: '121', systemid: '121' };

// A pre-flight must never be able to *cause* a failure — if Naukri changes the
// endpoint or the network hiccups, we return unknown and let the existing
// DOM-driven flow proceed exactly as before.
const UNKNOWN = { known: false, expired: false, externalUrl: null };

// Consecutive reCAPTCHA-gated responses before we stop trying this run. Three
// rather than one so a single blip doesn't disable a pre-flight that works.
const GATED_LIMIT = 3;
let consecutiveGated = 0;
let gaveUp = false;

// Exposed so a run can report whether the pre-flight was usable at all,
// instead of it silently doing nothing.
export function jdApiStatus() {
  return { disabled: gaveUp, consecutiveGated };
}

export function resetJdApiState() {
  consecutiveGated = 0;
  gaveUp = false;
}

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

  if (gaveUp) return UNKNOWN;

  // Read the status too, so a reCAPTCHA gate is distinguishable from a
  // genuine miss — otherwise we'd keep paying for a call that can never work.
  const result = await page.evaluate(async (id, headers) => {
    try {
      const res = await fetch(`https://www.naukri.com/jobapi/v4/job/${id}`, {
        headers,
        credentials: 'include',
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, json };
    } catch {
      return { status: 0, json: null };
    }
  }, jobId, API_HEADERS).catch(() => null);

  const gated = result?.status === 406 || /recaptcha/i.test(result?.json?.message || '');
  if (gated) {
    if (++consecutiveGated >= GATED_LIMIT) {
      gaveUp = true;
      console.warn('[naukri-jd-api] endpoint is reCAPTCHA-gated for this session — pre-flight disabled for this run');
    }
    return UNKNOWN;
  }
  consecutiveGated = 0;

  return interpretJobDetail(result?.json);
}
