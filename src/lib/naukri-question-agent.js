// Answers Naukri's chatbot screening questions.
//
// Three layers, cheapest first:
//   1. Deterministic rules  — the handful of questions that appear on nearly
//      every application (CTC, notice period, experience, relocation).
//   2. Persistent cache     — a question we've already reasoned about is
//      answered identically next time, for free.
//   3. LLM                  — anything genuinely novel ("do you have GST
//      registration?", "rate your Kubernetes skill 1-5"). This is the layer
//      the old pure-keyword implementation was missing: unrecognized
//      questions fell through to "pick the first option / echo total
//      experience", which silently submitted nonsense answers.
//
// Only layers 1 and 3 produce new answers; layer 2 just replays them.
import { PROFILE } from './profile.js';

const PROFILE_ANSWERS = {
  currentCtc: '7',
  expectedCtc: '14',
  noticePeriod: '15',
  experience: '2',
  location: 'Bengaluru',
  totalExp: '2',
};

export function cacheKeyFor(question, options = []) {
  return `${(question || '').trim().toLowerCase()}||${options.map(o => o.trim().toLowerCase()).sort().join('|')}`;
}

// Returns a string answer, or null if no rule applies.
//
// Option matching walks the preference list in OUR order, not the order the
// options happen to appear on screen — `options.find()` against one combined
// regex returns whichever option Naukri listed first, which picked
// "Immediate" over the truthful "15 days" for notice period.
function ruleAnswer(question, options = []) {
  const q = (question || '').toLowerCase();
  const preferInOrder = (patterns) => {
    for (const re of patterns) {
      const hit = options.find(o => re.test(o));
      if (hit) return hit;
    }
    return null;
  };

  if (/notice period|joining|when can you join|availability/.test(q)) {
    return options.length
      ? preferInOrder([/\b15\b/, /2\s*week/i, /less than 1 month/i, /1 month/i, /immediate/i])
      : PROFILE_ANSWERS.noticePeriod;
  }
  if (/current.?(ctc|salary|package)/.test(q)) {
    return options.length
      ? preferInOrder([/\b7\b/, /\b6\b/, /\b8\b/, /5\s*-\s*10/, /less than 10/i])
      : PROFILE_ANSWERS.currentCtc;
  }
  if (/expected.?(ctc|salary|package)|salary expectation/.test(q)) {
    return options.length
      ? preferInOrder([/\b14\b/, /\b1[2-5]\b/, /10\s*-\s*15/, /1[0-6]/])
      : PROFILE_ANSWERS.expectedCtc;
  }
  if (/total.?experience|years.?of.?experience|how many years/.test(q)) {
    return options.length
      ? preferInOrder([/1\s*-\s*2/, /0\s*-\s*2/, /2\s*-\s*4/, /1\s*-\s*3/, /^\s*2\s*$/, /^\s*1\s*$/])
      : PROFILE_ANSWERS.totalExp;
  }
  if (/relocat|willing to move|open to (work from|working from)|comfortable with/.test(q)) {
    return options.length ? preferInOrder([/^\s*yes/i]) : 'Yes';
  }
  if (/current location|which city|based in|preferred location/.test(q)) {
    return options.length
      ? preferInOrder([new RegExp(PROFILE_ANSWERS.location, 'i'), /bangalore/i])
      : PROFILE_ANSWERS.location;
  }
  return null;
}

function buildPrompt(question, options) {
  const optionBlock = options.length
    ? `\nOptions (reply with the NUMBER only):\n${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}`
    : '\nThere are no options — reply with a short free-text answer (max 8 words).';

  return `You are filling in a job-application screening question on behalf of a candidate. Answer truthfully from the profile below. Never invent qualifications the candidate does not have.

Candidate profile:
- Name: ${PROFILE.name}
- Role: ${PROFILE.title}
- Total experience: ${PROFILE.experienceYears} years
- Current location: ${PROFILE.currentLocation}
- Current CTC: ${PROFILE_ANSWERS.currentCtc} LPA; Expected: ${PROFILE_ANSWERS.expectedCtc} LPA
- Notice period: ${PROFILE_ANSWERS.noticePeriod} days
- Work authorization: ${PROFILE.workAuthorization}
- Skills: ${PROFILE.skills.join(', ')}
- Background: ${PROFILE.resumeHighlights.join(' ')}

Question: "${question}"${optionBlock}

Rules:
- If the question asks about a skill or tool the candidate does NOT have, answer honestly (choose the option meaning "no"/"0"/"none").
- Reply with ONLY the number (if options were listed) or the short answer text. No explanation, no punctuation-only answers, no markdown.`;
}

async function aiAnswer(question, options) {
  const prompt = buildPrompt(question, options);

  const tryParse = (raw) => {
    const text = (raw || '').replace(/```/g, '').trim();
    if (!text) return null;
    if (options.length) {
      const n = parseInt(text.match(/\d+/)?.[0], 10);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1];
      // Model replied with the option text instead of its number
      const hit = options.find(o => o.toLowerCase() === text.toLowerCase())
        || options.find(o => text.toLowerCase().includes(o.toLowerCase()));
      return hit || null;
    }
    return text.split('\n')[0].slice(0, 120);
  };

  if (process.env.GEMINI_API_KEY) {
    try {
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genai.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.0-flash' });
      const res = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }] });
      const parsed = tryParse(res.response.text());
      if (parsed) return parsed;
    } catch {}
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const res = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      });
      const parsed = tryParse(res.choices[0].message.content);
      if (parsed) return parsed;
    } catch {}
  }

  return null;
}

// cache: Map from readAnswerCache(); onResolved({key, question, answer, source})
// is called only when a NEW answer is produced, so the caller can persist it.
// Returns { answer, source } — answer is null when nothing could be determined
// (caller should then leave the field alone rather than guess).
export async function resolveAnswer({ question, options = [], cache, onResolved }) {
  const key = cacheKeyFor(question, options);

  const rule = ruleAnswer(question, options);
  if (rule) return { answer: rule, source: 'rule' };

  if (cache?.has(key)) {
    const cached = cache.get(key);
    // A cached option answer is only valid if it's still one of the offered options.
    if (!options.length || options.includes(cached)) return { answer: cached, source: 'cache' };
  }

  const ai = await aiAnswer(question, options);
  if (ai) {
    cache?.set(key, ai);
    await onResolved?.({ key, question, answer: ai, source: 'ai' });
    return { answer: ai, source: 'ai' };
  }

  return { answer: null, source: 'none' };
}

export { PROFILE_ANSWERS };
