// AI job analysis: Gemini → OpenAI → keyword fallback
import { scoreJob, getTier } from './matcher.js';
import {
  getProfileHighlightsText,
  getProfileRoleText,
  getProfileSkillsText,
  getProfileSummary,
} from './profile.js';

async function analyzeWithGemini(jobText) {
  if (!process.env.GEMINI_API_KEY) throw new Error('no key');
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genai.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: buildPrompt(jobText) }] }],
  });
  return parseResponse(result.response.text());
}

async function analyzeWithOpenAI(jobText) {
  if (!process.env.OPENAI_API_KEY) throw new Error('no key');
  const OpenAI = (await import('openai')).default;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: buildPrompt(jobText) }],
    temperature: 0,
  });
  return parseResponse(res.choices[0].message.content);
}

function buildPrompt(jobText) {
  return `You are evaluating a job posting for Pulkit Agarwal.

Target roles:
${getProfileRoleText()}

Core skills:
${getProfileSkillsText()}.

${getProfileSummary()}
Resume highlights:
${getProfileHighlightsText()}

Job posting:
"""
${jobText.slice(0, 2000)}
"""

Reply with ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "matchScore": <0-100 integer>,
  "matchTier": "<high|medium|low>",
  "matchedSkills": ["skill1", "skill2"],
  "aiSummary": "<1 sentence: why this is or isn't a good fit for Pulkit>"
}`;
}

function parseResponse(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(clean);
  return {
    matchScore: Math.min(100, Math.max(0, Number(parsed.matchScore) || 0)),
    matchTier: ['high', 'medium', 'low'].includes(parsed.matchTier) ? parsed.matchTier : getTier(parsed.matchScore || 0),
    matchedSkills: Array.isArray(parsed.matchedSkills) ? parsed.matchedSkills.slice(0, 6) : [],
    aiSummary: String(parsed.aiSummary || '').slice(0, 200),
  };
}

// Exported — tries Gemini first, then OpenAI, then falls back to keyword matcher
export async function analyzeJob(job) {
  const jobText = `${job.title}\n${job.description || ''}`;

  // Only call AI if there's enough description text to analyse
  if (jobText.length > 80) {
    try {
      return await analyzeWithGemini(jobText);
    } catch {}

    try {
      return await analyzeWithOpenAI(jobText);
    } catch {}
  }

  // Keyword fallback — always works, no API needed
  const { score, matchedSkills } = scoreJob(job);
  return {
    matchScore: score,
    matchTier: getTier(score),
    matchedSkills,
    aiSummary: null,
  };
}
