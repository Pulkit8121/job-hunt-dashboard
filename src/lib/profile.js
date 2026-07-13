export const PROFILE = {
  name: 'Pulkit Agarwal',
  phone: '+91 8299559013',
  title: 'Full-stack / backend engineer',
  currentLocation: 'Bengaluru, Karnataka',
  experienceYears: 1.9,
  minExperienceYears: 0,
  maxExperienceYears: 3,
  targetLocation: 'India',
  workAuthorization: 'India',
  minSalaryLpa: 12,
  preferredCities: [
    { slug: 'bengaluru', label: 'Bengaluru' },
    { slug: 'hyderabad', label: 'Hyderabad' },
    { slug: 'pune', label: 'Pune' },
    { slug: 'chennai', label: 'Chennai' },
    { slug: 'mumbai', label: 'Mumbai' },
    { slug: 'gurugram', label: 'Gurugram' },
    { slug: 'noida', label: 'Noida' },
    { slug: 'delhi-ncr', label: 'Delhi NCR' },
  ],
  discoveryRoles: [
    { slug: 'software-engineer', label: 'Software Engineer' },
    { slug: 'software-developer', label: 'Software Developer' },
    { slug: 'backend-developer', label: 'Backend Developer' },
    { slug: 'backend-engineer', label: 'Backend Engineer' },
    { slug: 'full-stack-developer', label: 'Full Stack Developer' },
    { slug: 'node-js-developer', label: 'Node.js Developer' },
    { slug: 'golang-developer', label: 'Go Developer' },
    { slug: 'platform-engineer', label: 'Platform Engineer' },
    { slug: 'frontend-developer', label: 'Frontend Developer' },
  ],
  scrapeRoles: [
    { slug: 'software-engineer', label: 'Software Engineer' },
    { slug: 'backend-developer', label: 'Backend Developer' },
    { slug: 'full-stack-developer', label: 'Full Stack Developer' },
    { slug: 'node-js-developer', label: 'Node.js Developer' },
    { slug: 'golang-developer', label: 'Go Developer' },
  ],
  roleKeywords: [
    'software engineer',
    'software developer',
    'backend engineer',
    'backend developer',
    'full stack',
    'fullstack',
    'frontend developer',
    'web developer',
    'platform engineer',
    'application developer',
    'go developer',
    'golang',
    'node.js',
    'nodejs',
    'react',
    'vue',
    'sde',
    'swe',
    'api',
  ],
  skills: [
    'GoLang',
    'Node.js',
    'Express.js',
    'React.js',
    'Next.js',
    'Vue.js',
    'JavaScript',
    'TypeScript',
    'Python',
    'C#/.NET',
    'MongoDB',
    'PostgreSQL',
    'Redis',
    'Docker',
    'Kubernetes',
    'AWS ECS/EC2/S3',
    'OIDC',
    'RBAC',
    'OAuth 2.0',
    'JWT',
    'Microservices',
    'REST APIs',
    'OpenAI API',
    'LLM integrations',
    'AI workflows',
    'Puppeteer',
    'Tailwind CSS',
  ],
  skillGroups: [
    { weight: 26, keywords: ['golang', 'go developer', 'go engineer', 'go backend', 'golang developer', 'go lang'] },
    { weight: 24, keywords: ['node.js', 'nodejs', 'node js', 'express.js', 'expressjs', 'express js'] },
    { weight: 22, keywords: ['microservices', 'microservice', 'distributed systems', 'micro services'] },
    { weight: 20, keywords: ['react.js', 'reactjs', 'react js', 'next.js', 'nextjs', 'next js'] },
    { weight: 17, keywords: ['vue.js', 'vuejs', 'vue js', 'vue 3', 'vue3'] },
    { weight: 16, keywords: ['docker', 'kubernetes', 'k8s', 'container', 'containerization'] },
    { weight: 15, keywords: ['oidc', 'oauth', 'oauth 2.0', 'oauth2', 'rbac', 'jwt', 'authentication', 'authorization', 'sso', 'identity'] },
    { weight: 14, keywords: ['aws', 'cloud', 'ecs', 'ec2', 's3', 'amazon location services'] },
    { weight: 13, keywords: ['openai', 'llm', 'ai workflow', 'prompt engineering', 'generative ai', 'gpt', 'claude', 'genai', 'dall-e', 'dalle'] },
    { weight: 11, keywords: ['mongodb', 'nosql', 'mongoose', 'mongo'] },
    { weight: 10, keywords: ['redis', 'cache', 'caching', 'redis cache'] },
    { weight: 10, keywords: ['typescript', 'type script', '.net', 'c#'] },
    { weight: 9, keywords: ['postgresql', 'postgres', 'sql database', 'rdbms'] },
    { weight: 8, keywords: ['python', 'django', 'flask', 'fastapi'] },
    { weight: 8, keywords: ['rest api', 'restful', 'rest apis', 'api development'] },
    { weight: 7, keywords: ['tailwind', 'tailwind css', 'bootstrap'] },
    { weight: 6, keywords: ['full stack', 'fullstack', 'full-stack'] },
    { weight: 5, keywords: ['javascript', 'web application', 'frontend'] },
    { weight: 5, keywords: ['git', 'github', 'gitlab', 'version control'] },
  ],
  resumeHighlights: [
    'Software Engineer at Magna International working on GoLang microservices, Vue.js dashboards, Docker/Kubernetes deployments, and OIDC/RBAC security.',
    'Full-Stack Developer at Cadera Infotech building React.js, Node.js, Express.js, MongoDB, and AI-powered workflow systems.',
    'Software Developer Intern at Foundry Digital building AWS ECS services, TypeScript/.NET integrations, and production monitoring workflows.',
    'Built a large personal Next.js platform with Puppeteer scraping, Redis caching, OpenAI/Claude integrations, automation pipelines, and marketing workflows.',
  ],
};

export function getProfileSummary() {
  return `${PROFILE.name} is a ${PROFILE.title} based in ${PROFILE.currentLocation} with ~${PROFILE.experienceYears} years of experience, authorized to work in ${PROFILE.workAuthorization}, and targeting ${PROFILE.minSalaryLpa}LPA+ roles across ${PROFILE.targetLocation}.`;
}

export function getProfileSkillsText() {
  return PROFILE.skills.join(', ');
}

export function getProfileRoleText() {
  return PROFILE.discoveryRoles.map(role => role.label).join(', ');
}

export function getProfileHighlightsText() {
  return PROFILE.resumeHighlights.join(' ');
}

export function getProfileHeaderLine() {
  return `${PROFILE.minSalaryLpa}LPA+ · India only · Go / Node / Full-Stack roles`;
}
