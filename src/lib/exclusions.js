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
