// Personalized cover letter generation: Gemini → OpenAI → static template fallback.
import {
  getProfileHighlightsText,
  getProfileSkillsText,
  PROFILE,
} from './profile.js';

function buildSignature() {
  return `Best regards,\n${PROFILE.name}\n${PROFILE.phone}`;
}

function wrapBody(body) {
  return `Hi,\n\n${body.trim()}\n\n${buildSignature()}`;
}

function buildPrompt(companyName) {
  return `Write the BODY PARAGRAPHS ONLY (no greeting, no sign-off, no signature — those are added separately) of a short, direct cold-outreach email from ${PROFILE.name}, a Full-Stack AI Engineer, to the HR/talent team at "${companyName}".

Context on the candidate:
- ${getProfileHighlightsText()}
- Core skills: ${getProfileSkillsText()}.
- ${PROFILE.experienceYears} years of experience, based in ${PROFILE.currentLocation}, open to roles across ${PROFILE.targetLocation}.

Requirements:
- 90-140 words, plain text (no markdown, no subject line, no greeting like "Hi", no sign-off, no placeholders like [Company]).
- Open with a direct, concrete statement of who the candidate is and what they're looking for at "${companyName}" — do NOT open with invented flattery about the company's "mission", "innovation", "culture", or similar guesses, since you have no real information about them beyond their name. Skip straight to substance.
- Mention 2-3 concrete, relevant skills/experience points, not a generic list.
- Mention the attached resume.
- End the paragraphs with a single direct line asking if they're open to a quick conversation — no "thank you for your time" filler.
- Do not invent facts not present in the context above.
- Avoid generic corporate phrases like "aligns with your mission", "passion for leveraging", "operational efficiency", "excited about the opportunity" — write plainly, like a real engineer emailing a person, not like a form letter.

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
  return `I'm ${PROFILE.name}, a Full-Stack AI Engineer with ${PROFILE.experienceYears} years of experience building production systems with ${getProfileSkillsText()}. I'm reaching out about full-stack or AI engineering opportunities at ${companyName}.

${getProfileHighlightsText()}

I've attached my resume. Open to a quick call if there's a fit?`;
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
