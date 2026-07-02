import { PROFILE } from './profile.js';

const INDIA_GEO = '102713980';

const PEOPLE_SEARCHES = [
  {
    id: 'talent-acquisition',
    label: 'Talent Acquisition',
    keywords: 'talent acquisition recruiter HR hiring',
    description: 'Find talent acquisition and hiring partners in India.',
    messageType: 'recruiter',
  },
  {
    id: 'technical-recruiters',
    label: 'Tech Recruiters',
    keywords: 'technical recruiter engineering recruiter tech hiring',
    description: 'Find recruiters focused on engineering hiring.',
    messageType: 'recruiter',
  },
  {
    id: 'early-careers',
    label: 'Early Careers',
    keywords: 'campus recruiter early careers university recruiter',
    description: 'Find early-career and junior hiring owners.',
    messageType: 'recruiter',
  },
  {
    id: 'engineering-managers',
    label: 'Engineering Managers',
    keywords: 'engineering manager software manager',
    description: 'Find direct engineering managers and team owners.',
    messageType: 'manager',
  },
  {
    id: 'backend-platform',
    label: 'Backend Leads',
    keywords: 'backend manager platform engineer manager engineering lead',
    description: 'Find backend and platform decision makers.',
    messageType: 'manager',
  },
  {
    id: 'senior-engineers',
    label: 'Senior Engineers',
    keywords: 'senior software engineer staff engineer software developer',
    description: 'Find senior ICs for peer referrals.',
    messageType: 'peer',
  },
  {
    id: 'tech-leads',
    label: 'Tech Leads',
    keywords: 'tech lead team lead software lead',
    description: 'Find tech leads and delivery owners.',
    messageType: 'peer',
  },
  {
    id: 'people-partners',
    label: 'HR Partners',
    keywords: 'hr business partner people partner hiring manager',
    description: 'Find HR partners who influence role routing.',
    messageType: 'recruiter',
  },
];

function buildPeopleSearchUrl(companyName, keywords) {
  const name = encodeURIComponent(companyName);
  const base = 'https://www.linkedin.com/search/results/people/';
  const geoParam = `&geoUrn=%5B%22${INDIA_GEO}%22%5D`;
  return `${base}?keywords=${encodeURIComponent(keywords)}&company=${name}${geoParam}`;
}

export function getLinkedInPeopleTargets(company) {
  const companyName = company.linkedinCompanyName || company.name;
  return PEOPLE_SEARCHES.map(search => ({
    ...search,
    url: buildPeopleSearchUrl(companyName, search.keywords),
    message: getTargetedMessage(company, search.messageType),
  }));
}

export function getTargetedMessage(company, messageType) {
  const name = company.name;
  if (messageType === 'manager') {
    return `Hi, I came across your profile while exploring opportunities at ${name}. I'm a backend/full-stack engineer (~2 years) working in GoLang, Node.js, React/Next.js, Vue.js, Docker/K8s, and microservices. I'd love to know if your team has any openings for someone with my profile — happy to share more details. Thanks!`;
  }
  if (messageType === 'peer') {
    return `Hi! I'm a backend/full-stack engineer with ~2 years of experience (GoLang, Node.js, React, Docker/K8s) exploring opportunities at ${name}. Would really appreciate a referral or any insight into the hiring process if you're open to it. No pressure at all — thanks for reading!`;
  }
  // recruiter / default
  return `Hi, I'm ${PROFILE.name}, a ${PROFILE.title} based in ${PROFILE.currentLocation} with ~${PROFILE.experienceYears} years of experience in GoLang, Node.js, React/Next.js, Vue.js, microservices, Docker/Kubernetes, and AI workflows. I'm actively looking for India-based software roles at ${name} (12LPA+) and would love to connect or learn about relevant openings.`;
}

export function getConnectionMessage(company) {
  return getTargetedMessage(company, 'recruiter');
}
