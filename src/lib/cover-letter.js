// Personalized cover letter generation: Gemini → OpenAI → static template fallback.
import { PROFILE } from './profile.js';

// Full accomplishment detail pulled straight from the resume — kept here
// rather than in profile.js since profile.js's highlights feed job-matching
// prompts elsewhere and are tuned for that, not for outreach email copy.
const EXPERIENCE_CONTEXT = `
- Currently Software Engineer at Magna International (Factory Solutions, since July 2025): builds GoLang microservices for AMR bot automation (dispatch service, error handling/monitoring), and independently designed + delivered an enterprise-grade RBAC-via-OIDC authentication system from scratch — gathered requirements across robotics/operations/security teams, architected the full auth/authorization flow, and built the Vue.js frontend with OIDC-token-based protected routes. Also works on SmartPick, a forklift/tugger bot automation platform. Stack: GoLang, Vue.js, Docker, Kubernetes.
- Before that, Full-Stack Developer at Cadera Infotech: built the Study Abroad section of CaderaEdu (React.js, Node.js/Express.js, MongoDB), including an admin/CRM dashboard and AI-powered workflows that automated ingestion and enrichment of college data.
- Before that, Software Developer Intern at Foundry Digital, a US-based startup: built a weather system for their Optifleet product using Amazon Location Services + OpenWeatherMap API, Dockerized it and deployed as an AWS ECS service, later re-engineered into their core .NET/TypeScript codebase with Prometheus monitoring.
- Personal project, CareerMentorEdu (careermentoredu.com): a full-stack EdTech platform built solo, with a fully autonomous admin dashboard — scrapes college data via Puppeteer, enriches content with Claude AI, generates images with DALL-E 3, produces marketing videos via HeyGen, and runs Meta Ads campaigns end-to-end with zero manual intervention.
- Core skills: React.js, Next.js, Vue.js, Node.js/Express.js, GoLang, MongoDB, PostgreSQL, Redis, Docker, Kubernetes, AWS, OIDC/RBAC/OAuth2/JWT, OpenAI/Claude/LLM integration.
`.trim();

function buildSignature() {
  return `Best regards,\n${PROFILE.name}\n${PROFILE.phone}`;
}

// Guarantees a paragraph break even if the model ignores the "2 paragraphs"
// instruction — splits right before the CareerMentorEdu sentence so it's never
// one wall-of-text block.
function enforceParagraphBreak(body) {
  if (/\n\s*\n/.test(body)) return body;
  const idx = body.indexOf('CareerMentorEdu');
  if (idx === -1) return body;
  const boundary = body.lastIndexOf('. ', idx);
  if (boundary === -1) return body;
  const splitPoint = boundary + 1;
  return `${body.slice(0, splitPoint).trim()}\n\n${body.slice(splitPoint).trim()}`;
}

function wrapBody(body) {
  return `Hi,\n\n${enforceParagraphBreak(body.trim())}\n\n${buildSignature()}`;
}

function buildPrompt(companyName) {
  return `Write the BODY PARAGRAPHS ONLY (no greeting, no sign-off, no signature — those are added separately) of a cold-outreach email from ${PROFILE.name}, a Full-Stack/AI Engineer, to the HR/recruiting team at "${companyName}".

Candidate background (use this, don't invent anything beyond it):
${EXPERIENCE_CONTEXT}

Requirements:
- 160-220 words, plain text (no markdown, no bold, no subject line, no greeting, no sign-off, no placeholders like [Company]).
- Write in EXACTLY 2 paragraphs separated by a blank line — never one big block of text. Paragraph 1: professional experience (Magna International, Cadera Infotech, Foundry Digital). Paragraph 2: the CareerMentorEdu project, the resume mention, and the closing line.
- Open with a direct, concrete statement of who the candidate is and what they're looking for at "${companyName}" — do NOT invent flattery about the company's "mission", "innovation", "culture", or similar guesses, since there's no real information about them beyond their name. Skip straight to substance.
- Do NOT state a specific number of years of experience (e.g. "1.9 years") — let the roles and companies speak for themselves instead.
- Cover ALL FOUR of: the current role at Magna International (RBAC-via-OIDC + bot automation), Cadera Infotech (React.js/Node.js/MongoDB + AI workflows), Foundry Digital — call it out explicitly as a US-based startup — and the CareerMentorEdu project. One or two concrete details per company/project is enough; don't just list job titles with no substance.
- Weave in a couple of the core skills naturally (e.g. GoLang, React.js/Vue.js, Docker/Kubernetes, OpenAI/Claude/LLM integration) rather than a bare list.
- Mention the attached resume.
- End with ONE low-pressure line inviting them to connect if there's a relevant opening — do NOT phrase it as a presumptuous question like "Are you open to a quick conversation?". Something like "Happy to share more if there's a role where this could be a fit." works.
- Do not invent facts beyond what's given above.
- Avoid generic corporate phrases like "aligns with your mission", "passion for leveraging", "operational efficiency", "excited about the opportunity", "significantly improved". Write plainly, like an engineer emailing a person, not a form letter.

Return ONLY the body paragraphs, nothing else.`;
}

async function generateWithGemini(companyName) {
  if (!process.env.GEMINI_API_KEY) throw new Error('no key');
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genai.getGenerativeModel({ model: 'gemini-1.5-flash' });
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: buildPrompt(companyName) }] }],
  });
  return result.response.text().trim();
}

async function generateWithOpenAI(companyName) {
  if (!process.env.OPENAI_API_KEY) throw new Error('no key');
  const OpenAI = (await import('openai')).default;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: buildPrompt(companyName) }],
    temperature: 0.6,
  });
  return res.choices[0].message.content.trim();
}

function fallbackBody(companyName) {
  return `I'm ${PROFILE.name}, a Full-Stack/AI Engineer, and I'm reaching out about full-stack or AI engineering opportunities at ${companyName}.

I'm currently at Magna International building GoLang microservices for bot automation and delivered an enterprise-grade RBAC-via-OIDC system from scratch. Before that, I was at Cadera Infotech (React.js/Node.js/MongoDB, AI-powered workflows) and Foundry Digital, a US-based startup (AWS ECS, .NET/TypeScript). I also built CareerMentorEdu (careermentoredu.com) solo — a full-stack EdTech platform with a fully autonomous AI content and ad-campaign pipeline.

I've attached my resume. Happy to share more if there's a role where this could be a fit.`;
}

export async function generateCoverLetter(companyName) {
  try {
    return wrapBody(await generateWithGemini(companyName));
  } catch {}
  try {
    return wrapBody(await generateWithOpenAI(companyName));
  } catch {}
  return wrapBody(fallbackBody(companyName));
}
