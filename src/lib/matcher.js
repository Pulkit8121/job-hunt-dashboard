import { PROFILE } from './profile.js';

const SKILLS = PROFILE.skillGroups;

const EXCLUDE_ROLES = ['sales', 'hr ', 'human resource', 'marketing', 'finance', 'accountant', 'legal',
  'qa engineer', 'quality assurance', 'seo', 'content writer', 'graphic design', 'ux designer',
  'data analyst', 'business analyst', 'product manager', 'program manager', 'scrum master',
  'principal engineer', 'staff engineer', 'vice president', 'director of', 'head of engineering',
  'vp engineering', 'chief ', 'cto', 'ceo'];

const INELIGIBLE_TITLE_HINTS = [
  'senior',
  'sr.',
  ' sr ',
  'lead ',
  'tech lead',
  'manager',
  'architect',
  'principal',
  'staff',
  'director',
  'head ',
  'vp ',
  'vice president',
  'intern',
  'internship',
  'apprentice',
  'distinguished',
];

const TARGET_ROLES = PROFILE.roleKeywords;

// Word-boundary matching, not naive substring — short/generic keywords like
// "swe" and "api" otherwise false-positive inside unrelated words ("Sweden",
// "Grand Rapids"). This was previously masked for the India-only Naukri flow
// (the separate India-location filter rejected those postings anyway) but
// causes real mismatches now that the company-portal apply flow has no such
// location filter — confirmed live: "Nurse Practitioner (Grand Rapids, MI)"
// matched via "api" in "Rapids", "...Sweden/Denmark" matched via "swe".
function keywordRegex(keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i');
}
const TARGET_ROLE_PATTERNS = TARGET_ROLES.map(keywordRegex);
const EXCLUDE_ROLE_PATTERNS = EXCLUDE_ROLES.map(r => keywordRegex(r.trim()));

const INDIA_LOCATION_PATTERNS = [
  /\bindia\b/,
  /\bbengaluru\b/,
  /\bbangalore\b/,
  /\bhyderabad\b/,
  /\bpune\b/,
  /\bgurugram\b/,
  /\bgurgaon\b/,
  /\bnoida\b/,
  /\bdelhi\b/,
  /\bnew delhi\b/,
  /\bmumbai\b/,
  /\bchennai\b/,
  /\bahmedabad\b/,
  /\bkolkata\b/,
  /\bkochi\b/,
  /\bcoimbatore\b/,
  /\bmohali\b/,
  /\bchandigarh\b/,
  /\bjaipur\b/,
  /\bindore\b/,
  /\bthiruvananthapuram\b/,
  /\btrivandrum\b/,
  /\bremote[, -]+india\b/,
  /\bindia[, -]+remote\b/,
];

const NON_INDIA_LOCATION_PATTERNS = [
  /\bworldwide\b/,
  /\bglobal\b/,
  /\bemea\b/,
  /\bapac\b/,
  /\bnorth america\b/,
  /\blatam\b/,
  /\beurope\b/,
  /\buk\b/,
  /\bunited kingdom\b/,
  /\bunited states\b/,
  /\busa\b/,
  /\bcanada\b/,
  /\bgermany\b/,
  /\bfrance\b/,
  /\bireland\b/,
  /\bitaly\b/,
  /\bnetherlands\b/,
  /\bspain\b/,
  /\bpoland\b/,
  /\bportugal\b/,
  /\bsingapore\b/,
  /\baustralia\b/,
  /\bnew zealand\b/,
  /\bjapan\b/,
  /\bchina\b/,
  /\bdubai\b/,
  /\buae\b/,
  /\bsaudi\b/,
];

// ── Broad role matching (company-portal / high-volume mode) ─────────────────
//
// PROFILE.roleKeywords is a deliberately narrow backend/full-stack list. Across
// a 2,060-posting corpus pulled from live Greenhouse boards it matched 6.7% of
// titles, which caps portal volume far below the 2k/day target.
//
// Naively widening to bare "engineer"/"developer" raises the hit rate but
// wrecks precision: the same corpus then matched "Plasma Dry Etch Engineer",
// "Dielectric and Polymer Materials Engineer" and "Photo Process Engineer" —
// semiconductor fab roles with nothing to do with software.
//
// So a generic job word only counts when a software signal appears alongside
// it, and an explicit non-software domain list vetoes regardless.
const SOFTWARE_ROLE_PHRASES = [
  'software engineer', 'software developer', 'software development engineer',
  'backend engineer', 'backend developer', 'back end engineer', 'back-end developer',
  'frontend engineer', 'frontend developer', 'front end engineer', 'front-end developer',
  'full stack engineer', 'full stack developer', 'fullstack engineer', 'fullstack developer',
  'full-stack engineer', 'full-stack developer',
  'web developer', 'application developer', 'applications engineer',
  'platform engineer', 'infrastructure engineer', 'systems engineer',
  'devops engineer', 'site reliability engineer', 'sre',
  'data engineer', 'machine learning engineer', 'ml engineer', 'ai engineer', 'mlops engineer',
  'mobile engineer', 'mobile developer', 'android developer', 'android engineer',
  'ios developer', 'ios engineer', 'game developer',
  'security engineer', 'application security engineer', 'cloud engineer',
  'integration engineer', 'solutions engineer', 'support engineer', 'sdet',
  'automation engineer', 'test automation engineer', 'qa automation engineer',
  'sde', 'swe', 'programmer', 'api engineer', 'api developer',
];

// Technology tokens that turn a generic "Engineer"/"Developer" into a
// software role. Kept to things that only appear in software postings.
const SOFTWARE_SIGNALS = [
  'react', 'angular', 'vue', 'svelte', 'node', 'nodejs', 'node.js', 'django', 'flask',
  'fastapi', 'rails', 'laravel', 'spring boot', 'dotnet', '.net', 'c#', 'golang', 'rust',
  'kotlin', 'scala', 'typescript', 'javascript', 'python', 'java', 'ruby', 'php', 'elixir',
  'graphql', 'rest', 'api', 'apis', 'microservices', 'kubernetes', 'docker', 'terraform',
  'aws', 'gcp', 'azure', 'cloud', 'backend', 'frontend', 'full stack', 'fullstack',
  'full-stack', 'web', 'mobile', 'android', 'ios', 'data', 'machine learning', 'ml', 'ai',
  'llm', 'platform', 'infrastructure', 'devops', 'database', 'distributed systems',
];
const GENERIC_JOB_WORDS = ['engineer', 'developer', 'development', 'programmer', 'engineering'];

// Domains that are emphatically not software, however the title is phrased.
const NON_SOFTWARE_DOMAINS = [
  'mechanical', 'electrical', 'chemical', 'civil', 'industrial', 'structural', 'materials',
  'manufacturing', 'process engineer', 'process integration', 'plasma', 'etch', 'lithography',
  'photolithography', 'semiconductor', 'wafer', 'polymer', 'dielectric', 'thermal', 'optical',
  'hardware', 'firmware', 'rf ', 'antenna', 'automotive', 'aerospace', 'petroleum', 'mining',
  'biomedical', 'clinical', 'environmental', 'geotechnical', 'metallurg', 'packaging',
  'field engineer', 'sales engineer', 'solutions architect', 'network engineer', 'facilities',
  'validation engineer', 'quality engineer', 'safety', 'nurse', 'technician', 'machinist',
];

const SOFTWARE_ROLE_PATTERNS   = SOFTWARE_ROLE_PHRASES.map(keywordRegex);
const SOFTWARE_SIGNAL_PATTERNS = SOFTWARE_SIGNALS.map(keywordRegex);
const GENERIC_JOB_PATTERNS     = GENERIC_JOB_WORDS.map(keywordRegex);
const NON_SOFTWARE_PATTERNS    = NON_SOFTWARE_DOMAINS.map(d => keywordRegex(d.trim()));

// Wider net than isRelevantJob, for the company-portal flow where the goal is
// volume across many role families rather than an exact backend match.
//
// Seniority is filtered by default via the existing isEligibleTitle policy.
// Without it the broad net pulls in "Senior Java Developer", "Senior Machine
// Learning Engineer" and "Associate Director, AI/ML Engineering" — measured on
// the live corpus — which are a poor use of an application slot at ~2 years of
// experience. Pass { includeSenior: true } (or set PORTAL_INCLUDE_SENIOR=true)
// to trade that precision for raw volume.
export function isRelevantJobBroad(title = '', { includeSenior = process.env.PORTAL_INCLUDE_SENIOR === 'true' } = {}) {
  const t = title.toLowerCase();
  if (NON_SOFTWARE_PATTERNS.some(re => re.test(t))) return false;
  if (EXCLUDE_ROLE_PATTERNS.some(re => re.test(t))) return false;
  if (!includeSenior && !isEligibleTitle(title)) return false;
  if (SOFTWARE_ROLE_PATTERNS.some(re => re.test(t))) return true;
  // Generic job word alone is not enough — it needs a software signal with it.
  const generic = GENERIC_JOB_PATTERNS.some(re => re.test(t));
  return generic && SOFTWARE_SIGNAL_PATTERNS.some(re => re.test(t));
}

export function isRelevantJob(title = '') {
  const t = title.toLowerCase();
  const hasTarget = TARGET_ROLE_PATTERNS.some(re => re.test(t));
  const hasExclude = EXCLUDE_ROLE_PATTERNS.some(re => re.test(t));
  return hasTarget && !hasExclude;
}

export function isEligibleTitle(title = '') {
  const text = title.toLowerCase();
  return !INELIGIBLE_TITLE_HINTS.some(hint => text.includes(hint));
}

export function extractMinExperience(text = '') {
  const clean = text.toLowerCase().replace(/\u2013|\u2014/g, '-');
  const patterns = [
    /(\d+)\s*-\s*(\d+)\s*(?:years?|yrs?)/,
    /(\d+)\s*to\s*(\d+)\s*(?:years?|yrs?)/,
    /(?:minimum|min\.?|at least|around)\s*(\d+)\+?\s*(?:years?|yrs?)/,
    /(\d+)\+?\s*(?:years?|yrs?)\s+(?:of\s+)?experience/,
    /experience\s*[:\-]?\s*(\d+)\+?\s*(?:years?|yrs?)/,
  ];

  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (!match) continue;
    return Number(match[1]);
  }

  return null;
}

export function isEligibleExperience(job = {}) {
  const minYears = extractMinExperience(
    `${job.experienceText || ''}\n${job.title || ''}\n${job.description || ''}`
  );

  return minYears == null || minYears <= PROFILE.maxExperienceYears;
}

export function isIndiaEligibleLocation(location = '', description = '') {
  const locationText = String(location || '').toLowerCase();
  const descriptionText = String(description || '').toLowerCase();

  const locationHasIndia = INDIA_LOCATION_PATTERNS.some(pattern => pattern.test(locationText));
  if (locationHasIndia) return true;

  if (locationText) {
    return false;
  }

  const descriptionHasIndia = INDIA_LOCATION_PATTERNS.some(pattern => pattern.test(descriptionText));
  const descriptionHasOutsideIndia = NON_INDIA_LOCATION_PATTERNS.some(pattern => pattern.test(descriptionText));
  return descriptionHasIndia && !descriptionHasOutsideIndia;
}

// Patterns that make a listing a guaranteed reject regardless of location —
// used by the company-portal apply agent, which otherwise applies worldwide
// (any city, remote, US tech remote — see PROFILE.globalLocationPreference)
// since the applicant is open to relocating/remote and will honestly answer
// "requires sponsorship" on the application itself rather than being
// pre-filtered out by geography.
const GUARANTEED_REJECT_PATTERNS = [
  /\bmust be(?:come)? a?.{0,25}\bcitizen/i,
  /\bcitizenship\s+required/i,
  /\bus\s+citizen(?:ship)?\s+(?:is\s+)?required/i,
  /\bsecurity clearance/i,
  /\bno\s+(?:visa\s+)?sponsorship/i,
  /\bunable to sponsor/i,
  /\bwill not sponsor/i,
  /\bdoes not (?:offer|provide) (?:visa )?sponsorship/i,
];

export function isGlobalEligibleLocation(location = '', description = '') {
  const text = `${location} ${description}`.toLowerCase();
  return !GUARANTEED_REJECT_PATTERNS.some(pattern => pattern.test(text));
}

// Same title/experience filters as filterEligibleJobs, but without the
// India-only location gate — for the company-portal apply flow, which is
// intentionally global rather than India-scoped like the Naukri flow.
export function filterGlobalEligibleJobs(jobs = [], limit = 15) {
  const eligible = [];
  const excluded = { title: 0, location: 0, experience: 0 };

  for (const job of jobs) {
    if (!isRelevantJob(job.title || '') || !isEligibleTitle(job.title || '')) {
      excluded.title++;
      continue;
    }
    if (!isGlobalEligibleLocation(job.location, job.description)) {
      excluded.location++;
      continue;
    }
    if (!isEligibleExperience(job)) {
      excluded.experience++;
      continue;
    }
    eligible.push(job);
    if (eligible.length >= limit) break;
  }

  return { eligible, excluded };
}

export function filterEligibleJobs(jobs = [], limit = 15) {
  const eligible = [];
  const excluded = {
    title: 0,
    location: 0,
    experience: 0,
  };

  for (const job of jobs) {
    if (!isRelevantJob(job.title || '')) {
      excluded.title++;
      continue;
    }

    if (!isEligibleTitle(job.title || '')) {
      excluded.title++;
      continue;
    }

    if (!isIndiaEligibleLocation(job.location, job.description)) {
      excluded.location++;
      continue;
    }

    if (!isEligibleExperience(job)) {
      excluded.experience++;
      continue;
    }

    eligible.push(job);
    if (eligible.length >= limit) break;
  }

  return { eligible, excluded };
}

export function scoreJob(job) {
  const text = `${job.title || ''} ${job.description || ''}`.toLowerCase();
  let totalScore = 0;
  const maxPossible = SKILLS.reduce((s, sk) => s + sk.weight, 0);
  const matchedSkills = [];

  for (const skill of SKILLS) {
    if (skill.keywords.some(kw => text.includes(kw))) {
      totalScore += skill.weight;
      matchedSkills.push(skill.keywords[0]);
    }
  }

  // Boost score so partial matches still show up reasonably
  const rawScore = (totalScore / maxPossible) * 100;
  const score = Math.min(100, Math.round(rawScore * 1.6));
  return { score, matchedSkills };
}

export function getTier(score) {
  if (score >= 65) return 'high';
  if (score >= 35) return 'medium';
  return 'low';
}
