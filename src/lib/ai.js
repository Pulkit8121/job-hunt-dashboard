// AI job analysis: LLM (see llm.js for provider order) → keyword fallback
import { scoreJob, getTier } from './matcher.js';
import { completeText } from './llm.js';
import {
  getProfileHighlightsText,
  getProfileRoleText,
  getProfileSkillsText,
  getProfileSummary,
} from './profile.js';

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

// Exported — tries the configured LLM providers, then falls back to the keyword matcher
export async function analyzeJob(job) {
  const jobText = `${job.title}\n${job.description || ''}`;

  // Only call AI if there's enough description text to analyse
  if (jobText.length > 80) {
    const text = await completeText(buildPrompt(jobText));
    if (text) {
      try { return parseResponse(text); } catch {}
    }
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
