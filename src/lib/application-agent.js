// Decides how to answer a single form field on a company-portal application.
// Deterministic keyword→answer rules run first (cheap, reliable, no API call)
// for the well-known fields every ATS asks (identity, EEO, sponsorship,
// experience). Only genuinely open-ended questions ("why do you want to work
// here?") fall back to an LLM, reusing the same Gemini→OpenAI pattern as
// src/lib/ai.js.
import { PROFILE } from './profile.js';
import { completeText } from './llm.js';
import { readAnswerCache, saveAnswer } from './db.js';

// Order matters — more specific patterns must come before generic ones that
// could otherwise over-match (e.g. "location" is generic; "linkedin" isn't).
const FIELD_RULES = [
  { test: /linkedin/i, value: () => PROFILE.linkedinUrl, kind: 'text' },
  { test: /github|portfolio|website/i, value: () => PROFILE.githubUrl, kind: 'text' },
  // Non-English forms are common on Recruitee/Teamtailor/Personio (measured:
  // a German Recruitee form left Telefonnummer, start date, salary and
  // Lebenslauf all unfilled because every rule was English-only).
  { test: /vorname|prénom|voornaam|nombre/i, value: () => PROFILE.name.split(' ')[0], kind: 'text' },
  { test: /nachname|nom de famille|achternaam|apellido/i, value: () => PROFILE.name.split(' ').slice(1).join(' '), kind: 'text' },
  { test: /telefon|téléphone|telefoon|teléfono/i, value: () => PROFILE.phone, kind: 'text' },
  { test: /lebenslauf|curriculum|cv\b/i, value: () => '', kind: 'file' },
  { test: /gehalt|gewünschte[sn]? gehalt|salaire|salaris/i, value: () => '14 LPA', kind: 'text' },
  { test: /frühesten|verfügbar|disponibilité|beschikbaar|startdatum/i, value: () => 'Immediate (15 days notice)', kind: 'text' },
  // Some forms expose no label at all and only a name attribute — Breezy uses
  // cName / cEmail / cPhoneNumber, which left all three required fields blank.
  { test: /^c?_?(full)?name$/i, value: () => PROFILE.name, kind: 'text' },
  { test: /^c?_?e-?mail(address)?$/i, value: () => PROFILE.email, kind: 'text' },
  { test: /^c?_?phone(number)?$/i, value: () => PROFILE.phone, kind: 'text' },
  { test: /first\s*name/i, value: () => PROFILE.name.split(' ')[0], kind: 'text' },
  { test: /last\s*name/i, value: () => PROFILE.name.split(' ').slice(1).join(' ') || PROFILE.name.split(' ')[0], kind: 'text' },
  { test: /full\s*name|applicant\s*name|^\s*name\s*$/i, value: () => PROFILE.name, kind: 'text' },
  { test: /e[-\s]?mail/i, value: () => PROFILE.email, kind: 'text' },
  // Country-code pickers sit next to the phone field and match /phone/ too,
  // but they want a dial code, not the full number. Measured on a live
  // Greenhouse form: the phone combobox offers 60 country options, and
  // feeding it the raw "+91 8299559013" matched none of them.
  { test: /country code|dial(?:ing)? code|phone.*country|country.*phone/i, value: () => '+91', kind: 'choice' },
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
  // "Are you authorized to work?" and "Do you need sponsorship?" are OPPOSITE
  // in polarity and must not share a rule. They previously did, so both were
  // answered "Yes" — which asserted US work authorization the applicant does
  // not have. Answered separately, and country-aware: authorized in India,
  // not authorized anywhere that would require a visa.
  {
    test: /(?:authoriz|eligible|legally able|right to work|permitted to work)[^?]{0,40}\bwork\b|\bwork\b[^?]{0,25}(?:authoriz|eligible)/i,
    value: (label = '') => (/\bindia\b/i.test(label) ? 'Yes' : 'No'),
    kind: 'choice',
  },
  { test: /sponsor/i, value: () => (PROFILE.eeo.requiresSponsorship ? 'Yes' : 'No'), kind: 'choice' },
  // Bare "visa status"-style prompts: state the real position rather than a yes/no.
  { test: /visa/i, value: () => 'Requires sponsorship — Indian citizen, no US work authorization', kind: 'text' },
  { test: /(?:current|preferred)\s*(?:location|city)|based in|where are you (?:currently )?located/i, value: () => PROFILE.currentLocation, kind: 'text' },
  // Each of these was measured going to the LLM on a single live Greenhouse
  // form, at ~1.3s a call. They have one correct answer from the profile, so
  // paying a model round trip for them is pure waste — and the free-text
  // answers it produced were worse than the deterministic ones.
  { test: /desired salary|salary expectation|expected compensation|compensation expectation/i, value: () => '14 LPA', kind: 'text' },
  { test: /(?:preferred )?start date|when can you start|availability to start/i, value: () => 'Immediate (15 days notice)', kind: 'text' },
  { test: /years of (?:relevant )?(?:work )?experience|how many years/i, value: () => String(PROFILE.experienceYears), kind: 'text' },
  { test: /willing to work overtime|able to work overtime/i, value: () => 'Yes', kind: 'choice' },
  { test: /may we contact your current employer|contact your present employer/i, value: () => 'No', kind: 'choice' },
  { test: /able to perform the essential function/i, value: () => 'Yes', kind: 'choice' },
  { test: /friends or relatives|know anyone (?:who works|at)/i, value: () => 'No', kind: 'choice' },
  { test: /military (?:service|experience)/i, value: () => 'No', kind: 'choice' },
  // Consent/certification checkboxes on employment applications. These are
  // affirmations of the applicant's own statements, not questions.
  { test: /i (?:hereby )?(?:certify|agree|authorize|acknowledge|understand)|applicant.s certification/i, value: () => 'Yes', kind: 'choice' },
  { test: /graduation (?:completion )?year|year of graduation/i, value: () => '2021', kind: 'text' },
  { test: /highest (?:level of )?education|education status|degree/i, value: () => "Bachelor's Degree", kind: 'text' },
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
  if (declineOpt) return declineOpt;

  // Falling back to options[0] is only defensible on a short, essentially
  // binary list where the first option is a coin-flip between Yes and No.
  // On a long list it is actively harmful: the phone-country picker on a live
  // Greenhouse form has 60 entries, so an unmatched answer would have
  // confidently submitted whichever country happened to sort first. Better to
  // leave the field for a human than to assert something untrue on it.
  return options.length <= 4 ? options[0] : null;
}

// Model output that still contains a fill-in-the-blank slot must never be
// submitted. Measured live: "Where are you currently located?" came back as
// "I am currently located in [Your City]", which would have gone into a real
// application verbatim.
function looksTemplated(text = '') {
  return /\[[^\]]{2,40}\]|\{\{|\byour (?:city|name|company|title)\b|<[a-z ]+>/i.test(text);
}

// Answers are cached across runs, keyed by question + options. Without this
// every application re-asked the model the same questions: one live Greenhouse
// form alone made 28 calls totalling 37.8s of pure answering, and repeated
// questions came back inconsistent — "May we contact your current employer?"
// got "No, I would prefer..." on one field and "Yes, you may contact..." on
// the duplicate of the same question on the same page.
let cachePromise = null;
function getCache() {
  if (!cachePromise) cachePromise = readAnswerCache().catch(() => new Map());
  return cachePromise;
}

function cacheKey(label, options = []) {
  return `${label.trim().toLowerCase()}||${options.map(o => o.trim().toLowerCase()).sort().join('|')}`;
}

async function generateOpenEndedAnswer(label, job) {
  const prompt = `You are answering a job application question on behalf of ${PROFILE.name}, a ${PROFILE.title} with ~${PROFILE.experienceYears} years of experience.

Resume highlights:
${PROFILE.resumeHighlights.join(' ')}

Job: ${job?.title || 'the role'} at ${job?.companyName || 'the company'}
${job?.description ? `Job description: ${job.description.slice(0, 800)}` : ''}

Question: "${label}"

Reply with ONLY the answer text (2-4 sentences, first person, no preamble, no markdown).`;

  // null when no provider answered — caller leaves the field blank rather than guess
  const text = await completeText(prompt, { temperature: 0.4 });
  if (!text || looksTemplated(text)) return null;
  return text;
}

// A required choice we can't interpret still has to be answered or the form
// won't submit — measured on Breezy, where 13 required radio groups were left
// blank because their labels came through as "section_1666121249877_ques…".
// Prefer an explicit decline option, then a neutral negative; never invent a
// qualification. Returns null if no safe option exists.
export function safeRequiredChoice(options = []) {
  const find = (re) => options.find(o => re.test(o));
  // Apostrophe forms matter here. A live Breezy EEO group offers "I don't
  // wish to answer", which a /do not wish/ pattern misses entirely — that one
  // gap left every required self-identification group unanswered. Match the
  // contracted and straight/curly-quote spellings too.
  return find(/prefer not|decline|choose not|do ?n[o']?t wish|don.t wish|rather not|wish to answer|not to answer|not to disclose|not to self.identify|not specified|unspecified|prefer to self/i)
      || find(/^\s*no\b/i)
      || null;
}

// field: { label, kind: 'text'|'choice', options?: string[] }
// job: the job object (title/description/companyName) for open-ended context.
// Returns a string answer, or null to leave the field untouched.
export async function answerField(field, job) {
  const label = field.label || '';

  for (const rule of FIELD_RULES) {
    if (!rule.test.test(label)) continue;
    // Some rules need the question text itself (e.g. work authorization
    // depends on which country the question is asking about).
    const target = rule.value(label);
    if (!target) return null;
    if (field.kind === 'choice' && field.options?.length) {
      return matchChoice(field.options, target);
    }
    return target;
  }

  if (field.kind === 'choice' && field.options?.length) {
    // Unrecognized choice field — don't guess on something we don't
    // understand, UNLESS leaving it blank would block the submission.
    return field.required ? safeRequiredChoice(field.options) : null;
  }

  const key = cacheKey(label, field.options);
  const cache = await getCache();
  if (cache.has(key)) return cache.get(key);

  const answer = await generateOpenEndedAnswer(label, job);
  if (!answer) return null;

  cache.set(key, answer);
  // Persist so the next application answers this question for free, and
  // identically.
  saveAnswer({ key, question: label, answer, source: 'ai' }).catch(() => {});
  return answer;
}
