// Ranked email-pattern generation.
//
// Two facts make this worth doing properly rather than guessing blindly:
//   1. A company uses ONE format org-wide. So a single confirmed address (e.g.
//      one scraped from a public git commit) unlocks every other employee.
//   2. When no address is known, format frequency is strongly predictable from
//      company size — so candidates can be *ranked* instead of shotgunned.
//
// Distribution below is Interseller's published per-headcount data. Startups
// skew hard to bare `first@`, large enterprises to `first.last@`.
//
// IMPORTANT: a generated address is a guess, not a verified mailbox. Sending to
// unverified guesses produces bounces, and bounce rate is exactly what mail
// providers use to judge sender reputation — so these are emitted with low
// confidence and should be verified (MX at minimum) before any bulk send.

const BUILDERS = {
  'first.last':  (f, l) => `${f}.${l}`,
  'flast':       (f, l) => `${f[0]}${l}`,
  'first':       (f)    => f,
  'firstlast':   (f, l) => `${f}${l}`,
  'first_last':  (f, l) => `${f}_${l}`,
  'f.last':      (f, l) => `${f[0]}.${l}`,
  'firstl':      (f, l) => `${f}${l[0]}`,
  'last.first':  (f, l) => `${l}.${f}`,
  'lastf':       (f, l) => `${l}${f[0]}`,
  'first-last':  (f, l) => `${f}-${l}`,
};

// Ordered most- to least-likely, by headcount band.
const RANKING_BY_SIZE = {
  startup:    ['first', 'first.last', 'flast', 'firstlast', 'f.last', 'first_last'],
  small:      ['flast', 'first.last', 'first', 'firstlast', 'f.last', 'first_last'],   // 500-1k
  medium:     ['first.last', 'flast', 'firstlast', 'first', 'f.last', 'first_last'],   // 1k-5k
  large:      ['first.last', 'flast', 'f.last', 'firstlast', 'first', 'first_last'],   // 5k+
};

export function sizeBandFor(headcount) {
  if (!headcount || headcount < 500) return 'startup';
  if (headcount < 1000) return 'small';
  if (headcount < 5000) return 'medium';
  return 'large';
}

function normalizeNamePart(s = '') {
  return s.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z]/g, '');
}

export function splitName(fullName = '') {
  const parts = fullName.trim().split(/\s+/).map(normalizeNamePart).filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts[parts.length - 1] };
}

// Works out which of the known formats an existing address uses, so it can be
// applied to other people at the same company. Returns a pattern id or null.
export function inferPattern(email, fullName) {
  const name = splitName(fullName);
  if (!name?.first || !name.last) return null;
  const local = (email || '').split('@')[0]?.toLowerCase();
  if (!local) return null;

  for (const [id, build] of Object.entries(BUILDERS)) {
    if (build(name.first, name.last) === local) return id;
  }
  return null;
}

// Given a set of {email, name} pairs from the same company, return the pattern
// that the majority use. This is the high-value path: one real address from a
// git commit tells you how to address everyone else.
// Requires a clear majority, not just a plurality of one. Indian naming makes
// this genuinely ambiguous — an initial used as a surname means
// `shridhar.p@` reads as both "first.last" and "first.l", and
// `saratchandra@` reads as both "firstlast" and a single-word "first". Picking
// a winner off one vote produced wrong formats in testing (Zerodha), and a
// wrong format generates confidently-wrong addresses, so prefer returning
// nothing over guessing.
export function inferPatternFromSamples(samples = [], { minVotes = 2, minShare = 0.6 } = {}) {
  const votes = new Map();
  let decided = 0;
  for (const s of samples) {
    const p = inferPattern(s.email, s.name);
    if (p) { votes.set(p, (votes.get(p) || 0) + 1); decided++; }
  }
  if (!votes.size) return null;

  const [topPattern, topVotes] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  // A single sample can be coincidence; a split vote means the evidence
  // conflicts. Either way, don't commit to a format.
  if (topVotes < minVotes) return null;
  if (topVotes / decided < minShare) return null;
  return topPattern;
}

// Returns [{ email, pattern, rank, confidence }], best guess first.
// `knownPattern` short-circuits the ranking to a single high-confidence answer.
export function generateCandidates({ fullName, domain, knownPattern = null, headcount = null, limit = 6 }) {
  const name = splitName(fullName);
  if (!name?.first || !domain) return [];
  const cleanDomain = domain.replace(/^www\./, '').toLowerCase();

  const build = (id) => {
    const fn = BUILDERS[id];
    if (!fn) return null;
    // Formats needing a surname are unusable when we only have one name.
    if (!name.last && id !== 'first') return null;
    const local = fn(name.first, name.last);
    return local ? `${local}@${cleanDomain}` : null;
  };

  if (knownPattern) {
    const email = build(knownPattern);
    return email ? [{ email, pattern: knownPattern, rank: 1, confidence: 'medium' }] : [];
  }

  const order = RANKING_BY_SIZE[sizeBandFor(headcount)];
  const out = [];
  for (const id of order) {
    const email = build(id);
    if (!email || out.some(o => o.email === email)) continue;
    out.push({ email, pattern: id, rank: out.length + 1, confidence: 'low' });
    if (out.length >= limit) break;
  }
  return out;
}

// Cheap sanity gate before a guess is worth keeping: does the domain even
// accept mail? A DNS MX lookup is free and, unlike SMTP probing, works fine
// from a cloud host (outbound port 25 is blocked on most VPS providers, which
// is why SMTP-level verification isn't used here).
export async function domainAcceptsMail(domain) {
  try {
    const dns = await import('node:dns/promises');
    const mx = await dns.resolveMx(domain.replace(/^www\./, ''));
    return Array.isArray(mx) && mx.length > 0;
  } catch {
    return false;
  }
}

export { BUILDERS, RANKING_BY_SIZE };
