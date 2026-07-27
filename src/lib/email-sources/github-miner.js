// Mines public GitHub commit metadata for real work email addresses.
//
// Git stores an author email in every commit, and GitHub serves it verbatim on
// the public REST API. For technical companies this is the highest-yield free
// source available: ~40-60% of contributors have not enabled GitHub's privacy
// address, so their real corporate mailbox is exposed.
//
// Two things it gives you that paid enrichment APIs charge for:
//   • Real, current addresses of engineers at a target company.
//   • The company's email FORMAT — which, since orgs use one format
//     throughout, unlocks addresses for anyone else whose name you know.
//
// Route note: older tools (paulirish/github-email and its many forks) read
// /users/{login}/events/public, which no longer works — GitHub stripped the
// commits array out of PushEvent payloads, so those tools return nothing. The
// working route is /repos/{owner}/{repo}/commits, used below.
//
// Auth: works unauthenticated at 60 requests/hour. Set GITHUB_TOKEN for
// 5,000/hour — strongly recommended for anything beyond a handful of companies.
import { inferPatternFromSamples } from './pattern-generator.js';

const API = 'https://api.github.com';
const TIMEOUT = 15000;

// Addresses that are real syntactically but useless as contacts.
const MASKED_RE = /@users\.noreply\.github\.com$/i;
const BOT_RE = /(\[bot\]|^bot@|noreply|no-reply|actions@github|copilot|dependabot|renovate|semantic-release|cursoragent|swe-agent|greenkeeper)/i;

function headers() {
  const h = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'JobHuntBot/1.0 (personal job-search tool)',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function gh(path) {
  const res = await fetch(`${API}${path}`, { headers: headers(), signal: AbortSignal.timeout(TIMEOUT) });
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get('x-ratelimit-reset');
    throw Object.assign(new Error('github rate limit reached'), { rateLimited: true, reset });
  }
  if (!res.ok) return null;
  return res.json();
}

export function isUsableEmail(email) {
  if (!email || !email.includes('@')) return false;
  if (MASKED_RE.test(email)) return false;
  if (BOT_RE.test(email)) return false;
  return true;
}

// Finds the GitHub org/user most likely to belong to a company.
// Verified against the org's own name/blog rather than trusting a slug guess —
// the same lesson as the ATS slug that resolved to an unrelated company.
export async function findOrg(companyName, domain = null) {
  const q = encodeURIComponent(companyName);
  const data = await gh(`/search/users?q=${q}+type:org&per_page=5`).catch(() => null);
  const candidates = data?.items || [];

  const normalize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const wantName = normalize(companyName);
  const wantDomain = domain ? domain.replace(/^www\./, '').toLowerCase() : null;

  for (const c of candidates) {
    const org = await gh(`/orgs/${c.login}`).catch(() => null);
    if (!org) continue;

    // Accept on a domain match (strongest) or a real name overlap.
    const blog = (org.blog || '').toLowerCase();
    if (wantDomain && blog.includes(wantDomain)) return org.login;

    const got = normalize(org.name || org.login);
    if (got && wantName) {
      const [shorter, longer] = got.length <= wantName.length ? [got, wantName] : [wantName, got];
      if (longer.includes(shorter) && shorter.length / longer.length >= 0.6) return org.login;
    }
  }
  return null;
}

// Mines an org's most-active repos for contributor emails.
// Returns { emails: [{email, name, source}], inferredPattern, reposScanned }
export async function mineOrg(orgLogin, { maxRepos = 4, commitsPerRepo = 100, preferDomain = null } = {}) {
  const repos = await gh(`/orgs/${orgLogin}/repos?sort=pushed&per_page=${maxRepos}`).catch(() => null);
  if (!Array.isArray(repos) || !repos.length) return { emails: [], inferredPattern: null, reposScanned: 0 };

  const byEmail = new Map();
  let scanned = 0;

  for (const repo of repos.slice(0, maxRepos)) {
    const commits = await gh(`/repos/${orgLogin}/${repo.name}/commits?per_page=${commitsPerRepo}`).catch((e) => {
      if (e.rateLimited) throw e;
      return null;
    });
    if (!Array.isArray(commits)) continue;
    scanned++;

    for (const c of commits) {
      for (const who of [c?.commit?.author, c?.commit?.committer]) {
        const email = (who?.email || '').toLowerCase().trim();
        if (!isUsableEmail(email) || byEmail.has(email)) continue;
        byEmail.set(email, { email, name: (who?.name || '').trim(), source: `github:${orgLogin}/${repo.name}` });
      }
    }
  }

  const all = [...byEmail.values()];

  // Corporate addresses are the valuable ones; personal gmail/etc. still help
  // infer the format only if they happen to match, so keep them separate.
  const corporate = preferDomain
    ? all.filter(e => e.email.endsWith(`@${preferDomain.replace(/^www\./, '').toLowerCase()}`))
    : all.filter(e => !/@(gmail|yahoo|outlook|hotmail|proton(mail)?|icloud|live|msn)\./i.test(e.email));

  // Infer the format ONLY from addresses on the company's own domain. Falling
  // back to personal addresses looked harmless but is meaningless: matching
  // "first.last" against john.smith@gmail.com says nothing about how
  // company.com is formatted, and storing that guess would generate confidently
  // wrong addresses (and therefore bounces). Verified: Swiggy returned 0
  // corporate addresses yet produced a "first.last" pattern from gmail samples.
  const inferredPattern = corporate.length ? inferPatternFromSamples(corporate) : null;

  return { emails: all, corporate, inferredPattern, reposScanned: scanned };
}

// One-call convenience: company -> { emails, corporate, inferredPattern }
export async function mineCompany(companyName, domain = null, opts = {}) {
  const org = await findOrg(companyName, domain);
  if (!org) return { org: null, emails: [], corporate: [], inferredPattern: null, reposScanned: 0 };
  const result = await mineOrg(org, { ...opts, preferDomain: domain });
  return { org, ...result };
}

// Rate-limit headroom, so a caller can stop before it starts erroring.
export async function rateLimit() {
  const data = await gh('/rate_limit').catch(() => null);
  return {
    core: data?.resources?.core || null,
    search: data?.resources?.search || null,
    authenticated: !!process.env.GITHUB_TOKEN,
  };
}
