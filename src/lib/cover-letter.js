// Personalized cover letter generation: Gemini → OpenAI → static template fallback.
import {
  getProfileHighlightsText,
  getProfileSkillsText,
  PROFILE,
} from './profile.js';

function buildPrompt(companyName) {
  return `Write a short, warm, specific cold-outreach email cover letter from ${PROFILE.name}, a Full-Stack AI Engineer, to the HR/talent team at "${companyName}".

Context on the candidate:
- ${getProfileHighlightsText()}
- Core skills: ${getProfileSkillsText()}.
- ${PROFILE.experienceYears} years of experience, based in ${PROFILE.currentLocation}, open to roles across ${PROFILE.targetLocation}.

Requirements:
- 120-180 words, plain text (no markdown, no subject line, no placeholders like [Company]).
- Open by naming the company specifically and why you're interested in a full-stack/AI engineering role there.
- Mention 2-3 concrete, relevant skills/experience points, not a generic list.
- Mention the attached resume.
- End with a polite call to action and sign off with just "${PROFILE.name}".
- Do not invent facts not present in the context above.

Return ONLY the email body text.`;
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

function fallbackTemplate(companyName) {
  return `Hi,

I'm ${PROFILE.name}, a Full-Stack AI Engineer with ${PROFILE.experienceYears} years of experience building production systems with ${getProfileSkillsText()}. I'm reaching out because I'd love to explore full-stack or AI engineering opportunities at ${companyName}.

${getProfileHighlightsText()}

I've attached my resume for more detail. I'd welcome the chance to talk about how I could contribute to your team — happy to share more about my background whenever convenient.

Thanks for your time,
${PROFILE.name}`;
}

export async function generateCoverLetter(companyName) {
  try {
    return await generateWithGemini(companyName);
  } catch {}
  try {
    return await generateWithOpenAI(companyName);
  } catch {}
  return fallbackTemplate(companyName);
}
