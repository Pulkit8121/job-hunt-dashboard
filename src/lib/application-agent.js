// Decides how to answer a single form field on a company-portal application.
// Deterministic keyword→answer rules run first (cheap, reliable, no API call)
// for the well-known fields every ATS asks (identity, EEO, sponsorship,
// experience). Only genuinely open-ended questions ("why do you want to work
// here?") fall back to an LLM, reusing the same Gemini→OpenAI pattern as
// src/lib/ai.js.
import { PROFILE } from './profile.js';

// Order matters — more specific patterns must come before generic ones that
// could otherwise over-match (e.g. "location" is generic; "linkedin" isn't).
const FIELD_RULES = [
  { test: /linkedin/i, value: () => PROFILE.linkedinUrl, kind: 'text' },
  { test: /github|portfolio|website/i, value: () => PROFILE.githubUrl, kind: 'text' },
  { test: /first\s*name/i, value: () => PROFILE.name.split(' ')[0], kind: 'text' },
  { test: /last\s*name/i, value: () => PROFILE.name.split(' ').slice(1).join(' ') || PROFILE.name.split(' ')[0], kind: 'text' },
  { test: /full\s*name|applicant\s*name|^\s*name\s*$/i, value: () => PROFILE.name, kind: 'text' },
  { test: /e[-\s]?mail/i, value: () => PROFILE.email, kind: 'text' },
  { test: /phone|mobile|contact number/i, value: () => PROFILE.phone, kind: 'text' },
  { test: /notice period/i, value: () => '15 days', kind: 'text' },
  { test: /current (?:ctc|salary|compensation)/i, value: () => '7 LPA', kind: 'text' },
  { test: /expected (?:ctc|salary|compensation)/i, value: () => '14 LPA', kind: 'text' },
  { test: /years?\s+of\s+experience|total\s+experience/i, value: () => String(PROFILE.experienceYears), kind: 'text' },
  { test: /how did you hear|referr(?:al|er)|source/i, value: () => 'Company careers page', kind: 'text' },
  { test: /veteran/i, value: () => PROFILE.eeo.veteranStatus, kind: 'choice' },
  { test: /disab(?:led|ility)/i, value: () => PROFILE.eeo.disabilityStatus, kind: 'choice' },
  { test: /race|ethnicity/i, value: () => PROFILE.eeo.ethnicity, kind: 'choice' },
  { test: /gender|sex\b/i, value: () => PROFILE.eeo.gender, kind: 'choice' },
  { test: /pronoun/i, value: () => 'He/Him', kind: 'choice' },
  { test: /sponsor|visa|work authorization|legally (?:able|eligible|authorized)/i, value: () => (PROFILE.eeo.requiresSponsorship ? 'Yes' : 'No'), kind: 'choice' },
  { test: /(?:current|preferred)\s*(?:location|city)|based in|where are you located/i, value: () => PROFILE.currentLocation, kind: 'text' },
  { test: /relocat/i, value: () => 'Yes', kind: 'choice' },
  { test: /remote/i, value: () => 'Yes', kind: 'choice' },
];

// Picks the option string that best matches a target answer, so we submit an
// actual valid choice from the form rather than free text the field might
// reject. Falls back to a "prefer not to say" / "decline" style option if one
// exists and nothing else matches (safer than guessing on EEO fields), else
// the first option.
export function matchChoice(options = [], target = '') {
  if (!options.length) return null;
  const t = target.toLowerCase();

  const exact = options.find(o => o.toLowerCase() === t);
  if (exact) return exact;

  const contains = options.find(o => o.toLowerCase().includes(t) || t.includes(o.toLowerCase()));
  if (contains) return contains;

  if (/no|not|decline|prefer not/i.test(t)) {
    const declineOpt = options.find(o => /decline|prefer not|choose not/i.test(o));
    if (declineOpt) return declineOpt;
  }
  if (/yes/i.test(t)) {
    const yesOpt = options.find(o => /^yes/i.test(o.trim()));
    if (yesOpt) return yesOpt;
  }

  const declineOpt = options.find(o => /decline|prefer not|choose not|do not wish/i.test(o));
  return declineOpt || options[0];
}

async function generateOpenEndedAnswer(label, job) {
  const prompt = `You are answering a job application question on behalf of ${PROFILE.name}, a ${PROFILE.title} with ~${PROFILE.experienceYears} years of experience.

Resume highlights:
${PROFILE.resumeHighlights.join(' ')}

Job: ${job?.title || 'the role'} at ${job?.companyName || 'the company'}
${job?.description ? `Job description: ${job.description.slice(0, 800)}` : ''}

Question: "${label}"

Reply with ONLY the answer text (2-4 sentences, first person, no preamble, no markdown).`;

  if (process.env.GEMINI_API_KEY) {
    try {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genai.getGenerativeModel({ model: 'gemini-1.5-flash' });
      const result = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }] });
      const text = result.response.text().trim();
      if (text) return text;
    } catch {}
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const res = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.4,
      });
      const text = res.choices[0].message.content?.trim();
      if (text) return text;
    } catch {}
  }

  return null; // no AI available and no deterministic rule — caller should leave the field blank
}

// field: { label, kind: 'text'|'choice', options?: string[] }
// job: the job object (title/description/companyName) for open-ended context.
// Returns a string answer, or null to leave the field untouched.
export async function answerField(field, job) {
  const label = field.label || '';

  for (const rule of FIELD_RULES) {
    if (!rule.test.test(label)) continue;
    const target = rule.value();
    if (!target) return null;
    if (field.kind === 'choice' && field.options?.length) {
      return matchChoice(field.options, target);
    }
    return target;
  }

  if (field.kind === 'choice' && field.options?.length) {
    // Unrecognized choice field — don't guess on something we don't understand.
    return null;
  }

  return generateOpenEndedAnswer(label, job);
}
