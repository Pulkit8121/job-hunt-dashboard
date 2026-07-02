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

export function isRelevantJob(title = '') {
  const t = title.toLowerCase();
  const hasTarget = TARGET_ROLES.some(r => t.includes(r));
  const hasExclude = EXCLUDE_ROLES.some(r => t.includes(r));
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
