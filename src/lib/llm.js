// Single entry point for every LLM call in the app.
//
// Previously each feature (job scoring, mail classification, reply
// classification, form answering, screening questions) carried its own
// copy of the Gemini→OpenAI fallback, each hardcoding a model name. When
// gemini-1.5-flash was retired, all five silently degraded to keyword/default
// paths with no visible error — the failure mode this module exists to prevent.
//
// Provider order is configurable because which provider actually works is an
// account/billing fact, not a code fact. A provider that fails with a
// non-transient error (bad key, model gone, no quota) is marked dead for the
// rest of the process so we stop paying a failed round trip per call.

const ORDER = (process.env.LLM_PROVIDER_ORDER || 'openai,gemini')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

// provider -> reason string, once it's known to be unusable this run
const dead = new Map();

function isTerminal(err) {
  const m = (err?.message || '').toLowerCase();
  const status = err?.status || err?.code;
  if (status === 401 || status === 403 || status === 404) return true;
  if (status === 429) return true; // out of quota — retrying every call is pointless
  return /not found|no longer available|api key|quota|unauthorized|permission/.test(m);
}

async function callOpenAI(prompt, { temperature, maxTokens }) {
  if (!process.env.OPENAI_API_KEY) throw Object.assign(new Error('no OPENAI_API_KEY'), { status: 401 });
  const OpenAI = (await import('openai')).default;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await client.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
  });
  return res.choices?.[0]?.message?.content?.trim() || '';
}

async function callGemini(prompt, { temperature }) {
  if (!process.env.GEMINI_API_KEY) throw Object.assign(new Error('no GEMINI_API_KEY'), { status: 401 });
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genai.getGenerativeModel({ model: GEMINI_MODEL });
  const res = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    ...(temperature != null ? { generationConfig: { temperature } } : {}),
  });
  return (res.response.text() || '').trim();
}

const PROVIDERS = { openai: callOpenAI, gemini: callGemini };

// Returns the model's text, or null when no provider could answer.
// Never throws — callers treat null as "fall back to deterministic logic".
export async function completeText(prompt, { temperature = 0, maxTokens } = {}) {
  for (const name of ORDER) {
    const fn = PROVIDERS[name];
    if (!fn || dead.has(name)) continue;
    try {
      const text = await fn(prompt, { temperature, maxTokens });
      if (text) return text;
    } catch (e) {
      if (isTerminal(e)) {
        dead.set(name, e.message);
        console.warn(`[llm] provider "${name}" disabled for this process: ${e.message.slice(0, 140)}`);
      }
    }
  }
  return null;
}

// True when at least one provider is configured and not already known-dead.
export function llmAvailable() {
  return ORDER.some(n => PROVIDERS[n] && !dead.has(n) && (
    (n === 'openai' && process.env.OPENAI_API_KEY) ||
    (n === 'gemini' && process.env.GEMINI_API_KEY)
  ));
}

export function llmStatus() {
  return {
    order: ORDER,
    openaiModel: OPENAI_MODEL,
    geminiModel: GEMINI_MODEL,
    disabled: Object.fromEntries(dead),
  };
}
