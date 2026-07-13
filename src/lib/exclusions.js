// Companies to NEVER auto-apply to — freelance clients where Pulkit already
// works, so an application showing his current employer from the resume would be
// awkward. Applies to BOTH Naukri and Wellfound flows.
//
// Override/extend via env: EXCLUDED_COMPANIES="drytis,dofin,acme corp"
const DEFAULT_EXCLUDED = ['drytis', 'dofin'];

function normalize(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function getExcludedCompanies() {
  const fromEnv = (process.env.EXCLUDED_COMPANIES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const list = fromEnv.length ? fromEnv : DEFAULT_EXCLUDED;
  return list.map(normalize);
}

// True if `name` matches (as a substring, ignoring case/punctuation) any excluded
// company. Substring match catches "Drytis Technologies", "Dofin Pvt Ltd", etc.
export function isExcludedCompany(name, excluded = getExcludedCompanies()) {
  const n = normalize(name);
  if (!n) return false;
  return excluded.some(ex => ex && n.includes(ex));
}

// Domains to NEVER send cold-outreach emails to — current employer (Magna) and
// freelance clients (Drytis, Dofin) where Pulkit already works, so an unsolicited
// job-seeking email to their own HR/company address would be awkward.
//
// Override/extend via env: EXCLUDED_OUTREACH_DOMAINS="magna.com,drytis.com,dofin.co"
const DEFAULT_EXCLUDED_OUTREACH_DOMAINS = ['magna.com', 'drytis.com', 'dofin.co'];

export function getExcludedOutreachDomains() {
  const fromEnv = (process.env.EXCLUDED_OUTREACH_DOMAINS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_EXCLUDED_OUTREACH_DOMAINS;
}

// True if `url` or `email`'s domain matches (exactly, or as a subdomain of) any
// excluded outreach domain.
export function isExcludedOutreachDomain(urlOrEmail, excludedDomains = getExcludedOutreachDomains()) {
  if (!urlOrEmail) return false;
  let host;
  if (urlOrEmail.includes('@')) {
    host = urlOrEmail.split('@')[1];
  } else {
    try { host = new URL(urlOrEmail).hostname; } catch { host = urlOrEmail; }
  }
  host = (host || '').toLowerCase();
  if (!host) return false;
  return excludedDomains.some(d => host === d || host.endsWith(`.${d}`));
}

// True if a company `name` looks like it belongs to one of the excluded outreach
// domains (derived from the domain's own name, e.g. "magna.com" -> "magna"
// catches "Magna International"). Used to skip a company before even searching
// for its site, so we don't waste a lookup on a company we'd exclude anyway.
export function isExcludedOutreachCompany(name, excludedDomains = getExcludedOutreachDomains()) {
  const n = normalize(name);
  if (!n) return false;
  const fragments = excludedDomains.map(d => normalize(d.split('.')[0]));
  return fragments.some(f => f && n.includes(f));
}
