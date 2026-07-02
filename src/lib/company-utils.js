import { PROFILE } from './profile.js';

export const COMPANY_TYPES = ['easy-mnc', 'remote-mnc', 'hard', 'startup', 'unknown'];
export const WORK_MODES = ['remote', 'hybrid', 'onsite', 'unknown'];
export const ATS_TYPES = ['naukri', 'greenhouse', 'lever'];
export const DIFFICULTIES = ['easy', 'moderate', 'hard'];

export const DISCOVERY_ROLE_SEARCHES = PROFILE.discoveryRoles;

export const DISCOVERY_CITY_SEARCHES = PROFILE.preferredCities;

export const SCRAPE_ROLE_SEARCHES = PROFILE.scrapeRoles;

const REMOTE_MNC_HINTS = ['thoughtworks', 'gitlab', 'canonical', 'harness', 'automattic'];
const EASY_MNC_HINTS = [
  'nagarro',
  'publicis sapient',
  'persistent systems',
  'mercedes-benz',
  'mercedes benz',
  'aptiv',
  'fedex',
  'akamai',
  'bosch',
  'siemens',
  'philips',
  'dell',
  'ey',
  'sap',
];
const HARD_HINTS = [
  'google',
  'microsoft',
  'amazon',
  'atlassian',
  'uber',
  'flipkart',
  'swiggy',
  'zomato',
  'razorpay',
  'phonepe',
  'cred',
  'browserstack',
  'postman',
  'freshworks',
  'meesho',
  'groww',
];
const STARTUP_HINTS = [
  'labs',
  'fintech',
  'healthtech',
  'mobility',
  'commerce',
  'payments',
  'robotics',
];

const INTERVIEW_NOTES_BY_TYPE = {
  'easy-mnc': 'Estimated easier-to-moderate loop with practical coding and role-fit rounds.',
  'remote-mnc': 'Estimated remote-friendly loop with coding, collaboration, and async/team-fit checks.',
  hard: 'Estimated competitive loop with stronger coding depth and multiple technical rounds.',
  startup: 'Estimated practical startup loop with ownership, execution, and full-stack/backend depth.',
};

export function slugifyCompanyId(value = '') {
  return value
    .toLowerCase()
    .trim()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

export function buildNaukriSearchUrl(name = '') {
  const slug = slugifyCompanyId(name);
  return slug ? `https://www.naukri.com/${slug}-jobs` : '';
}

export function buildNaukriRoleSearchUrl(roleSlug, citySlug, companyName) {
  const base = `https://www.naukri.com/${roleSlug}-jobs-in-${citySlug}`;
  const params = new URLSearchParams({
    experience: String(PROFILE.minExperienceYears),
    maxExperience: String(PROFILE.maxExperienceYears),
    salary: String(PROFILE.minSalaryLpa * 100000),
  });

  if (companyName) params.set('companies', companyName);
  return `${base}?${params.toString()}`;
}

export function normalizeLocations(value) {
  if (Array.isArray(value)) {
    return value.map(v => String(v).trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value.split(',').map(v => v.trim()).filter(Boolean);
  }

  return [];
}

function hasAnyHint(name, hints) {
  return hints.some(hint => name === hint || name.includes(hint));
}

export function inferCompanyDefaults(name = '') {
  const cleanName = name.trim();
  const lowerName = cleanName.toLowerCase();

  let type = 'unknown';
  let workMode = 'unknown';
  let difficulty = '';

  if (hasAnyHint(lowerName, REMOTE_MNC_HINTS)) {
    type = 'remote-mnc';
    workMode = 'remote';
    difficulty = 'moderate';
  } else if (hasAnyHint(lowerName, HARD_HINTS)) {
    type = 'hard';
    difficulty = 'hard';
  } else if (hasAnyHint(lowerName, EASY_MNC_HINTS)) {
    type = 'easy-mnc';
    workMode = 'hybrid';
    difficulty = 'easy';
  } else if (hasAnyHint(lowerName, STARTUP_HINTS)) {
    type = 'startup';
    difficulty = 'moderate';
  }

  if (lowerName.includes('remote') || lowerName.includes('distributed')) {
    workMode = 'remote';
  }

  const locations = workMode === 'remote' ? ['Remote'] : [PROFILE.preferredCities[0]?.label || 'Bengaluru'];
  const salaryRange =
    type === 'hard' ? '20+ LPA' :
    type === 'remote-mnc' ? '18+ LPA' :
    type === 'startup' ? '14+ LPA' :
    '12+ LPA';

  return {
    type,
    workMode,
    difficulty,
    interviewNote: difficulty ? INTERVIEW_NOTES_BY_TYPE[type] : '',
    locations,
    salaryRange,
  };
}

export function buildCompanyRecord(input = {}) {
  const name = String(input.name || '').trim();
  const inferred = inferCompanyDefaults(name);
  const locations = normalizeLocations(input.locations);

  const company = {
    id: input.id || slugifyCompanyId(name),
    name,
    type: input.type || inferred.type,
    workMode: input.workMode || inferred.workMode,
    difficulty: input.difficulty ?? inferred.difficulty,
    interviewNote: input.interviewNote ?? inferred.interviewNote,
    locations: locations.length ? locations : inferred.locations,
    careersUrl: String(input.careersUrl || '').trim(),
    naukriSearchUrl: String(input.naukriSearchUrl || '').trim() || buildNaukriSearchUrl(name),
    wellfoundUrl: String(input.wellfoundUrl || '').trim(),
    linkedinCompanyName: String(input.linkedinCompanyName || '').trim() || name,
    salaryRange: String(input.salaryRange || '').trim() || inferred.salaryRange,
    atsType: input.atsType || 'naukri',
    atsSlug: String(input.atsSlug || '').trim(),
    lastScraped: input.lastScraped ?? null,
    autoDiscovered: Boolean(input.autoDiscovered),
  };

  if (!company.difficulty) delete company.difficulty;
  if (!company.interviewNote) delete company.interviewNote;

  return company;
}
