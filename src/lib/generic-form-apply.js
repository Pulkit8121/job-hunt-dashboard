// ATS-agnostic Puppeteer form-filling engine. Greenhouse, Lever, and Ashby all
// render a normal HTML form once you land on the job's apply page — rather
// than hardcoding a selector map per ATS (brittle, breaks on redesigns), this
// reads whatever fields the page actually has and fills them via
// application-agent.js. Aborts (does not attempt to solve) on any detected
// CAPTCHA/bot-challenge.
import path from 'path';
import { answerField } from './application-agent.js';
import { PROFILE } from './profile.js';
import {
  extractComboboxes, openComboboxOptions, chooseComboboxOption,
  findUnfilledRequired, readFieldErrors, findAdvanceControl, clickAdvanceControl,
  dismissConsentBanner, auditFilledForm,
} from './ats-widgets.js';

const RESUME_PATH = process.env.RESUME_PATH || path.join(process.cwd(), 'data', 'resume.pdf');
// 25s was too tight for this 1-core server under load — bumped to 40s so a
// slow-but-alive page load doesn't get thrown away as a hard failure.
const NAV_TIMEOUT = 40000;

// Only an INTERACTIVE, visible challenge actually blocks submission. Greenhouse
// (and many ATSes) load reCAPTCHA v3, which is passive/invisible score-based and
// does NOT gate the form — the mere presence of a "recaptcha" script tag is not a
// challenge. So we look specifically for a visibly-rendered captcha widget (v2
// checkbox / challenge popup, hCaptcha, Cloudflare Turnstile) or a full-page
// Cloudflare interstitial. If none is visible, we just submit.
async function hasBlockingCaptcha(page) {
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 10 && r.height > 10 &&
             s.visibility !== 'hidden' && s.display !== 'none' && el.offsetParent !== null;
    };
    const widgets = [...document.querySelectorAll(
      'iframe[src*="recaptcha/api2/anchor" i], iframe[src*="recaptcha/api2/bframe" i],' +
      'iframe[title*="recaptcha challenge" i], iframe[src*="hcaptcha.com" i],' +
      'iframe[title*="hcaptcha" i], iframe[src*="challenges.cloudflare.com" i],' +
      'div.g-recaptcha, div.h-captcha, div.cf-turnstile'
    )];
    if (widgets.some(isVisible)) return true;
    if (/just a moment|checking your browser|attention required|verify you are human/i.test(document.title)) return true;
    return false;
  }).catch(() => false);
}

// Runs entirely in-page: tags every fillable input/select/textarea with a
// data-agent-ref so we can address it again from Node after deciding answers.
async function extractFields(page) {
  return page.evaluate(() => {
    function labelFor(el) {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l && l.textContent.trim()) return l.textContent.trim();
      }
      const wrapping = el.closest('label');
      if (wrapping && wrapping.textContent.trim()) return wrapping.textContent.trim();
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();

      // Container fallback, but ONLY when the container holds this one field.
      // Measured on a live Greenhouse form: a wide container matched by
      // [class*="field"] wrapped 8 distinct inputs, so every one of them read
      // back the container's first label — all eight were labelled
      // "First Name*" and all eight were filled with the first name. Requiring
      // the container to be single-field makes that impossible.
      const group = el.closest('[class*="field" i], [class*="question" i], fieldset, [role="group"]');
      if (group) {
        const fieldsInGroup = group.querySelectorAll('input:not([type=hidden]), select, textarea');
        if (fieldsInGroup.length === 1) {
          const heading = group.querySelector('label, legend, [class*="label" i]');
          if (heading && heading.textContent.trim() && heading !== el) return heading.textContent.trim();
        }
      }
      return el.placeholder || el.getAttribute('aria-labelledby') ? '' : (el.placeholder || el.name || '');
    }

    // Fields that must never be touched by the answering agent.
    // - g-recaptcha-response is the CAPTCHA token slot; a live run wrote an
    //   LLM-generated sentence into it.
    // - honeypots are bot traps: filling them flags the submission.
    // - a field with no discoverable label is unanswerable, and guessing
    //   produced a generic cover-letter blob in seven unrelated inputs.
    function isUnanswerable(el, label) {
      const name = (el.name || el.id || '').toLowerCase();
      if (/recaptcha|captcha|csrf|token|honeypot|__|bot-?field/.test(name)) return true;
      if (el.autocomplete === 'off' && /^(url|website)$/.test(name) && !label) return true;
      return !label || label.length < 2;
    }

    const results = [];
    const seenGroups = new Set();
    let i = 0;

    document.querySelectorAll('input, select, textarea').forEach((el) => {
      if (el.disabled || el.readOnly) return;
      if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button' || el.type === 'image') return;

      const refId = `agent-field-${i++}`;
      const elLabel = labelFor(el);

      // File inputs are matched by count/label downstream, and choice groups
      // carry their own labels, so only free-text fields are gated here.
      // Skipping unlabelled fields avoids junk answers, but a REQUIRED
      // unlabelled field then blocks submission — measured on Greenhouse as a
      // required-empty with no label. Fall back to any weaker identifier
      // before giving up on it.
      const required = el.required || el.getAttribute('aria-required') === 'true';
      // Derive a label from the name attribute when there is no visible one.
      // Skipping unlabelled fields avoids junk LLM answers, but it also
      // skipped real fields: a Teamtailor form left candidate[phone] and
      // candidate[location][query] blank purely because neither carried a
      // <label>, even though the name says exactly what they are.
      // nameToLabel strips the wrapper syntax: candidate[phone] -> "phone".
      const nameToLabel = (n = '') => n
        .replace(/^[a-z_]+\[/i, '').replace(/\]\[/g, ' ').replace(/[[\]_-]+/g, ' ')
        .replace(/\s+/g, ' ').trim();
      const derived = elLabel || el.placeholder || nameToLabel(el.name || '')
        || (required ? (el.getAttribute('data-testid') || '') : '');
      const fallbackLabel = derived;
      // A label we inferred rather than read is trustworthy enough for the
      // deterministic rules but not for free-text generation, where a wrong
      // guess becomes a sentence in someone's application.
      const weakLabel = !elLabel;
      if (el.type !== 'file' && el.type !== 'radio' && el.type !== 'checkbox'
          && el.tagName !== 'SELECT' && isUnanswerable(el, fallbackLabel)) {
        return;
      }

      if (el.type === 'radio' || el.type === 'checkbox') {
        const groupKey = el.name || refId;
        if (seenGroups.has(groupKey)) return;
        seenGroups.add(groupKey);
        const group = el.name
          ? Array.from(document.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`))
          : [el];
        group.forEach((g, gi) => g.setAttribute('data-agent-ref', `${refId}-opt-${gi}`));

        // Breezy renders EEO radios with no wrapping <label> and no label[for],
        // so both the question and every option came back empty and 11
        // required groups went unanswered. The shared name attribute
        // ("race_ethnicity", "gender") is a perfectly good question label, and
        // the value attribute is a perfectly good option label.
        const optLabel = (g, gi) => {
          const direct = labelFor(g);
          if (direct) return direct;
          const sibling = (g.nextElementSibling?.textContent || g.parentElement?.textContent || '').trim();
          if (sibling && sibling.length < 90) return sibling;
          return (g.value || `option ${gi + 1}`).replace(/[_-]+/g, ' ').trim();
        };
        // labelFor on the first radio returns that OPTION's text, not the
        // question — a Breezy gender group came through labelled "Male", so
        // the EEO rules never fired and it fell back to a decline answer.
        // When the group label is just one of its own options, the shared
        // name attribute ("gender", "race_ethnicity", "eeoc.veteran_status")
        // is the real question.
        const firstLabel = labelFor(el);
        const optionTexts = group.map((g, gi) => optLabel(g, gi));
        const labelIsAnOption = firstLabel && optionTexts.some(o => o === firstLabel);
        const groupLabel = (!firstLabel || labelIsAnOption)
          ? (el.name || firstLabel || '').replace(/[._-]+/g, ' ').trim()
          : firstLabel;
        results.push({
          refId,
          label: groupLabel,
          kind: 'choice',
          required: group.some(g => g.required || g.getAttribute('aria-required') === 'true'),
          multi: el.type === 'checkbox' && group.length > 1,
          options: group.map((g, gi) => ({ ref: `${refId}-opt-${gi}`, label: optionTexts[gi] })),
        });
        return;
      }

      el.setAttribute('data-agent-ref', refId);

      if (el.tagName === 'SELECT') {
        results.push({
          refId,
          label: labelFor(el),
          kind: 'choice',
          options: Array.from(el.options).map((o, oi) => ({ ref: String(oi), label: o.textContent.trim() })).filter(o => o.label),
        });
      } else if (el.type === 'file') {
        results.push({
          refId,
          label: labelFor(el),
          kind: 'file',
          required: el.required || el.getAttribute('aria-required') === 'true',
        });
      } else {
        results.push({
          refId,
          label: fallbackLabel || labelFor(el),
          kind: el.tagName === 'TEXTAREA' ? 'textarea' : 'text',
          weakLabel,
        });
      }
    });

    return results;
  });
}

// International phone widgets prepend whatever country is selected and then
// reformat what you type. Writing "+91 8299559013" into one produced
// "+246 82995 59013" — British Indian Ocean Territory — which would have been
// submitted as an unreachable number. Compact E.164 with no spaces is what
// these widgets actually parse to set the country themselves.
function normalizePhoneForField(value) {
  return value.replace(/[^\d+]/g, '');
}

// Intl phone widgets (intl-tel-input and friends) attach keyboard handlers and
// ignore a programmatic value write — the native setter fires an input event
// but the widget's own formatter never runs, so the field keeps the country
// prefix it defaulted to. Measured twice: a Greenhouse field kept "+246" and a
// Dutch Recruitee field kept "+31" while our number was discarded. Typing the
// digits as real key events is what those widgets actually listen for.
async function typeTextField(page, refId, value) {
  const handle = await page.$(`[data-agent-ref="${refId}"]`);
  if (!handle) return false;
  try {
    await handle.scrollIntoView().catch(() => {});
    // Click alone is not enough to guarantee focus — if the input is covered
    // by an overlay the click lands elsewhere and every keystroke goes to
    // whatever *is* focused. Measured on Teamtailor: typing raised no error
    // and left the field completely empty.
    await handle.click({ clickCount: 3 }).catch(() => {});
    await handle.evaluate(el => el.focus()).catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await handle.type(value, { delay: 12 });
    await handle.evaluate(el => el.dispatchEvent(new Event('change', { bubbles: true }))).catch(() => {});

    // Verify rather than trusting "no exception thrown". Returning true here
    // when nothing landed is what suppressed the setter fallback and left the
    // field blank. A widget that reformats (spaces, country prefix) is fine —
    // only compare the digits.
    const got = await handle.evaluate(el => el.value || '').catch(() => '');
    const digitsOf = (v) => v.replace(/\D/g, '');
    if (!got.trim()) return false;
    if (/\d/.test(value) && digitsOf(value) && !digitsOf(got).includes(digitsOf(value).slice(-8))) return false;
    return true;
  } catch {
    return false;
  } finally {
    await handle.dispose();
  }
}

async function fillTextField(page, refId, value) {
  await page.evaluate((ref, val) => {
    const el = document.querySelector(`[data-agent-ref="${ref}"]`);
    if (!el) return;
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, val); else el.value = val;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }, refId, value);
}

async function fillSelectField(page, refId, chosenLabel) {
  await page.evaluate((ref, label) => {
    const el = document.querySelector(`[data-agent-ref="${ref}"]`);
    if (!el) return;
    const opt = Array.from(el.options).find(o => o.textContent.trim() === label);
    if (!opt) return;
    el.value = opt.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, refId, chosenLabel);
}

async function clickChoiceOption(page, optionRef) {
  const handle = await page.$(`[data-agent-ref="${optionRef}"]`);
  if (!handle) return;
  await handle.click().catch(() => {});
  await handle.dispose();
}

// Attaches the resume and CONFIRMS it landed.
//
// Returning true on "uploadFile did not throw" was wrong for dropzone-style
// widgets: Teamtailor accepted the call, swapped its hidden input for a fresh
// one, and ended up with no file attached — the run reported a successful
// upload and submitted without a CV. Verified by re-reading the input's own
// FileList, with one retry against a freshly-queried handle since the element
// we uploaded to may no longer be the one the widget is using.
async function uploadResume(page, refId) {
  const attach = async () => {
    const handle = await page.$(`[data-agent-ref="${refId}"]`);
    if (!handle) return null;
    try {
      await handle.uploadFile(RESUME_PATH);
      await new Promise(r => setTimeout(r, 400));
      return await handle.evaluate(el => el.files?.length || 0).catch(() => 0);
    } catch {
      return 0;
    } finally {
      await handle.dispose();
    }
  };

  if (await attach()) return true;

  // Second attempt: the widget may have replaced the input, so target whatever
  // file input is now present and unfilled rather than the original ref.
  const retried = await page.evaluate(() => {
    const empty = [...document.querySelectorAll('input[type="file"]')]
      .find(e => !e.disabled && !(e.files?.length));
    if (!empty) return null;
    empty.setAttribute('data-agent-ref', 'agent-resume-retry');
    return true;
  }).catch(() => null);
  if (!retried) return false;

  const handle = await page.$('[data-agent-ref="agent-resume-retry"]');
  if (!handle) return false;
  try {
    await handle.uploadFile(RESUME_PATH);
    await new Promise(r => setTimeout(r, 400));
    return (await handle.evaluate(el => el.files?.length || 0).catch(() => 0)) > 0;
  } catch {
    return false;
  } finally {
    await handle.dispose();
  }
}

// Whether a file field should get the resume. Matching on the label alone
// missed every drag-and-drop uploader whose <input type="file"> is visually
// hidden and carries no label at all — the form then bounced for a missing
// required attachment. If the page has exactly one file field, it is the
// resume field; there is nothing else it could be.
// Which file input gets the resume, given every file field on the page.
// Returns the winning field, or null.
//
// Choosing per-field by label then falling back to "first one" was wrong on
// Workable: both of its file inputs carry the label "SVGs not supported by
// this browser." (an <svg> fallback node), so the fallback attached the
// resume to input 0 — the OPTIONAL one — while input 1 was the required
// upload and stayed empty, failing the submission.
//
// Deciding across all candidates at once lets a required input win over a
// merely-first one.
function pickResumeField(fileFields) {
  if (!fileFields.length) return null;

  const isJunkLabel = (l = '') => !l || /svgs? not supported|choose file|drop your file|drag and drop/i.test(l);
  const named = (re) => fileFields.find(f => !isJunkLabel(f.label) && re.test(f.label));

  // Localised: a German Recruitee form labels the CV field "Lebenslauf".
  const explicit = named(/resume|cv\b|curriculum|lebenslauf|hoja de vida|cv-fil|meritförteckning/i);
  if (explicit) return explicit;

  const notResume = /cover.?letter|anschreiben|lettre|photo|portfolio|transcript|certificate|additional/i;
  const usable = fileFields.filter(f => isJunkLabel(f.label) || !notResume.test(f.label));
  if (!usable.length) return null;
  if (usable.length === 1) return usable[0];

  // A required upload is the one that blocks submission, so it wins.
  return usable.find(f => f.required) || usable[0];
}

async function findAndClickSubmit(page) {
  return page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button, input[type="submit"]'));
    const btn = candidates.find(b => {
      const text = (b.textContent || b.value || '').trim().toLowerCase();
      return /submit|apply/.test(text) && b.offsetParent !== null && !b.disabled;
    });
    if (!btn) return false;
    btn.click();
    return true;
  });
}

async function detectOutcomeText(page) {
  return page.evaluate(() => document.body.innerText.slice(0, 3000).toLowerCase()).catch(() => '');
}

function pageHasFillableFields(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('input, select, textarea')].some(
      e => !e.disabled && !['hidden', 'submit', 'button', 'image'].includes(e.type)
    )
  ).catch(() => false);
}

// The discovered job.link is the posting/description page for Lever & Ashby — the
// actual application form lives elsewhere (Lever: {url}/apply; Ashby: a React
// route revealed by the "Apply" button). Greenhouse renders the form inline, so
// this is a no-op there. Navigates/clicks through to a page that actually has
// fillable fields so the rest of the flow has a form to work with.
// Does this page have an actual APPLICATION form, as opposed to a posting
// page that merely contains a search box or newsletter input? Requiring a file
// input or a decent field count avoids being fooled by the latter — a
// Teamtailor posting page satisfied "has fillable fields" on its site search
// alone, so the flow never routed to the real form and filled 4 of 10 fields
// on the wrong one.
function pageHasApplicationForm(page) {
  return page.evaluate(() => {
    const usable = [...document.querySelectorAll('input, select, textarea')]
      .filter(e => !e.disabled && !['hidden', 'submit', 'button', 'image'].includes(e.type));
    const hasFile = usable.some(e => e.type === 'file');
    const hasEmail = usable.some(e => e.type === 'email' || /e-?mail/i.test(e.name + e.id));
    return hasFile || (hasEmail && usable.length >= 4);
  }).catch(() => false);
}

async function ensureApplyForm(page, job) {
  if (await pageHasApplicationForm(page)) return;

  // Teamtailor: the application form is a stable sub-path off the posting,
  // the same shape as Lever's /apply.
  if (job.atsType === 'teamtailor') {
    const base = page.url().split('?')[0].replace(/\/+$/, '');
    if (!/\/applications\/new$/.test(base)) {
      await page.goto(`${base}/applications/new`, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT }).catch(() => {});
      await page.waitForSelector('input[type="file"], form input', { timeout: 10000 }).catch(() => {});
      if (await pageHasApplicationForm(page)) return;
    }
  }

  // Lever: application form is a stable /apply sub-path.
  if (job.atsType === 'lever') {
    const current = page.url().replace(/\/+$/, '');
    if (!/\/apply$/.test(current)) {
      await page.goto(`${current}/apply`, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT }).catch(() => {});
      await page.waitForSelector('form input, form textarea, input[type="file"]', { timeout: 10000 }).catch(() => {});
      return;
    }
  }

  // Ashby (and any generic posting page): click an Apply/Application control that
  // routes to or reveals the form, then wait for fields to render.
  const clicked = await page.evaluate(() => {
    const els = [...document.querySelectorAll('a, button, [role="button"]')];
    const el = els.find(e => {
      const t = (e.textContent || '').trim().toLowerCase();
      return /^(apply|apply for this job|apply now|application|submit an application|i'?m interested)\b/.test(t);
    });
    if (el) { el.click(); return true; }
    return false;
  }).catch(() => false);

  if (clicked) {
    await page.waitForSelector('form input, form textarea, input[type="file"]', { timeout: 12000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
  }
}

// A wizard that hasn't reached a submit control after this many pages is
// either looping or asking for things we can't supply; stop and let it be
// finished by hand rather than clicking forever.
const MAX_STEPS = 6;

// Fills every fillable control currently on screen — native inputs first, then
// the custom comboboxes that the native sweep can't see. Returns how many
// fields actually received a value, which is what tells the caller whether
// this step was a real form page or just a landing screen.
async function fillVisibleFields(page, job, { only = null } = {}) {
  const native = await extractFields(page);
  const combos = await extractComboboxes(page, native.length);
  let filled = 0;

  const wanted = (refId) => !only || only.has(refId);
  const resumeField = pickResumeField(native.filter(f => f.kind === 'file'));

  for (const field of native) {
    if (!wanted(field.refId)) continue;

    if (field.kind === 'file') {
      if (field.refId === resumeField?.refId && await uploadResume(page, field.refId)) filled++;
      continue;
    }

    if (field.kind === 'choice') {
      const options = field.options.map(o => o.label);
      const answer = await answerField({ label: field.label, kind: 'choice', options, required: field.required }, job);
      if (!answer) continue;
      const chosen = field.options.find(o => o.label === answer);
      if (!chosen) continue;
      // <select> options use numeric index refs; radio/checkbox use element refs.
      if (/^\d+$/.test(chosen.ref) && field.options.length && !field.multi && field.refId) {
        await fillSelectField(page, field.refId, answer).catch(() => {});
      } else {
        await clickChoiceOption(page, chosen.ref);
      }
      filled++;
      continue;
    }

    const answer = await answerField({ label: field.label, kind: field.kind, weakLabel: field.weakLabel }, job);
    if (answer) {
      const isPhone = /phone|mobile|telefon|téléphone|telefoon/i.test(field.label);
      if (isPhone) {
        const digits = normalizePhoneForField(answer);
        // Real typing first; fall back to the setter if the field refuses it.
        const typed = await typeTextField(page, field.refId, digits).catch(() => false);
        if (!typed) await fillTextField(page, field.refId, digits).catch(() => {});
      } else {
        await fillTextField(page, field.refId, answer).catch(() => {});
      }
      filled++;
    }
  }

  // Comboboxes have to be opened before their options exist in the DOM, so
  // they can't be answered from the same static extract pass as the rest.
  for (const combo of combos) {
    if (!wanted(combo.refId)) continue;
    const options = await openComboboxOptions(page, combo.refId);
    if (!options.length) continue;
    // Forward `required` so an unrecognised but mandatory dropdown falls back
    // to a safe option instead of being left blank and bouncing the form.
    const answer = await answerField({ label: combo.label, kind: 'choice', options, required: combo.required }, job);
    if (!answer) {
      await page.keyboard.press('Escape').catch(() => {});
      continue;
    }
    if (await chooseComboboxOption(page, combo.refId, answer)) filled++;
    else await page.keyboard.press('Escape').catch(() => {});
  }

  return filled;
}

// Second pass over anything still marked required-and-empty. The label carried
// by the validation markup is often more descriptive than the one the field
// itself exposes, so re-asking with it frequently succeeds where the first
// pass returned null.
async function fillRequiredGaps(page, job) {
  const gaps = await findUnfilledRequired(page);
  if (!gaps.length) return 0;
  const refs = new Set(gaps.map(g => g.ref).filter(Boolean));
  if (!refs.size) return 0;
  return fillVisibleFields(page, job, { only: refs });
}

// Re-fills only the fields the form itself flagged. Returns true if it changed
// anything, i.e. whether a resubmit is worth attempting.
async function repairFromErrors(page, job) {
  const errors = await readFieldErrors(page);
  if (!errors.length) return false;
  const refs = new Set(errors.map(e => e.ref).filter(Boolean));
  // Errors with no resolvable field (a form-level banner) are not repairable
  // by refilling, so don't burn a resubmit on them.
  if (!refs.size) return (await fillRequiredGaps(page, job)) > 0;
  const filled = await fillVisibleFields(page, job, { only: refs });
  const gapsFilled = await fillRequiredGaps(page, job);
  return filled + gapsFilled > 0;
}

// Fill, read the form back, repair what is wrong, read it back again.
//
// A single fill pass reports success per-write, but a write can land and then
// be reverted by the page's own React state, an answer can be a template
// placeholder, or one answer can end up duplicated across distinct questions.
// None of that is visible from the write side — only from reading the
// finished form. Measured on live Greenhouse forms, this is where wrong data
// was getting through.
//
// Bounded at MAX_FIX_PASSES: repairs that don't converge in a couple of
// rounds are a form we don't understand, and repeating won't help.
const MAX_FIX_PASSES = 2;

// Values that legitimately repeat across a form (the applicant's own details),
// so the duplicate-answer check doesn't flag them.
function profileValues() {
  return [PROFILE.name, PROFILE.email, PROFILE.phone, PROFILE.linkedinUrl,
          PROFILE.githubUrl, PROFILE.currentLocation].filter(Boolean);
}

// Problem kinds a refill can plausibly fix. A bad email format won't improve
// by asking again — that's a rule bug, worth surfacing but not looping on.
const REPAIRABLE = new Set([
  'required-empty', 'required-choice-empty', 'placeholder-value',
  'duplicated-answer', 'overlong-value', 'wrong-country-code', 'bad-phone',
]);

// Intl phone widgets keep their own country state that typing does not always
// change — a live Greenhouse form rendered an Indian number as
// "+246 82995 59013" (British Indian Ocean Territory). When the audit reports
// that, set the country explicitly through the widget's own selector instead
// of retyping the number and getting the same result.
async function repairPhoneCountry(page) {
  const combos = await extractComboboxes(page, 900);
  const phoneCombo = combos.find(c => /phone|country|code/i.test(c.label) || !c.label);
  if (!phoneCombo) return false;
  const opts = await openComboboxOptions(page, phoneCombo.refId);
  if (!opts.length) return false;
  const want = opts.find(o => /\bindia\b/i.test(o) && /\+?91\b/.test(o))
            || opts.find(o => /\bindia\b/i.test(o));
  if (!want) { await page.keyboard.press('Escape').catch(() => {}); return false; }
  return chooseComboboxOption(page, phoneCombo.refId, want);
}

async function fillAndVerify(page, job, { onNote = () => {} } = {}) {
  let filledCount = await fillVisibleFields(page, job);
  await fillRequiredGaps(page, job);

  let audit = await auditFilledForm(page, { profileValues: profileValues() });

  for (let pass = 1; pass <= MAX_FIX_PASSES; pass++) {
    const fixable = audit.problems.filter(p => REPAIRABLE.has(p.kind));
    if (!fixable.length) break;

    // A phone field holding only a country prefix ("+31") means the write was
    // rejected by the widget, not that the number is wrong — retry the number
    // itself as well as the country selector.
    const phoneProblem = fixable.find(p => p.kind === 'wrong-country-code' || p.kind === 'bad-phone');
    if (phoneProblem) {
      await repairPhoneCountry(page).catch(() => {});
      if (phoneProblem.ref) {
        await typeTextField(page, phoneProblem.ref, PROFILE.phone.replace(/[^\d+]/g, '')).catch(() => {});
      }
    }

    // Clear a bad value before refilling: leaving a placeholder or a
    // duplicated sentence in place means the refill has to overwrite it, and
    // some controlled inputs ignore a write that doesn't change length.
    const refs = new Set(fixable.map(p => p.ref).filter(Boolean));
    if (refs.size) {
      await page.evaluate((list) => {
        for (const ref of list) {
          const el = document.querySelector(`[data-agent-ref="${ref}"]`);
          if (!el || !('value' in el)) continue;
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
          if (setter) setter.call(el, ''); else el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, [...refs]).catch(() => {});
      filledCount += await fillVisibleFields(page, job, { only: refs });
    }
    await fillRequiredGaps(page, job);

    const before = audit.problems.length;
    audit = await auditFilledForm(page, { profileValues: profileValues() });
    onNote(`repair pass ${pass}: ${before} problem(s) -> ${audit.problems.length}`);

    // No improvement means the next pass won't help either.
    if (audit.problems.length >= before) break;
  }

  return { filledCount, audit };
}

// 'success' | 'error' | 'unknown', from the page's own post-submit copy.
async function classifyOutcome(page) {
  const text = await detectOutcomeText(page);
  const looksSuccessful = /thank you|application (?:received|submitted|complete)|successfully applied|we('| ha)ve received your application/.test(text);
  const looksError = /required field|please fill|error|something went wrong|invalid/.test(text);
  if (looksSuccessful && !looksError) return 'success';
  if (looksError) return 'error';
  return 'unknown';
}

// Returns { success, reason, captcha? }
export async function applyToPortalJob(browser, job, { dryRun = false, onNote = () => {} } = {}) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.goto(job.link, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
    await page.waitForSelector('form, input, textarea', { timeout: 10000 }).catch(() => {});

    // A consent overlay sits on top of the form and swallows clicks — measured
    // on a JazzHR posting where the only reachable controls were "Allow" and
    // "Reject All" with the whole application form behind them. Declines
    // (never accepts), which both clears the overlay and is the
    // privacy-preserving choice.
    await dismissConsentBanner(page);

    // Lever/Ashby posting pages don't carry the form — route to the real apply form.
    await ensureApplyForm(page, job);

    // Some boards only raise the banner once the form route loads.
    await dismissConsentBanner(page);

    // A real, interactive challenge (v2 checkbox, hCaptcha, Turnstile, Cloudflare
    // interstitial) genuinely blocks submission — route it to the manual queue.
    // Passive reCAPTCHA v3 does not block, so we just proceed and submit.
    if (await hasBlockingCaptcha(page)) {
      return { success: false, reason: 'captcha-detected', captcha: true };
    }

    // Multi-step wizard loop. The original single-pass version filled page one,
    // looked for a Submit button, and gave up with "no-submit-button-found"
    // whenever the form paginated behind a Next/Continue — 72 skips in the
    // database. Bounded at MAX_STEPS so a form that loops (or a Next button
    // that never advances) can't hold the run open.
    let filledAnything = false;

    let lastAudit = null;

    for (let step = 1; step <= MAX_STEPS; step++) {
      const { filledCount, audit } = await fillAndVerify(page, job, { onNote });
      lastAudit = audit;
      if (filledCount > 0) filledAnything = true;

      if (step === 1 && filledCount === 0) {
        const anyFields = await pageHasFillableFields(page);
        if (!anyFields) return { success: false, reason: 'no-form-fields-found' };
      }

      // Dry run stops here: everything up to the point of no return has
      // happened, so the audit describes exactly what would have been sent.
      if (dryRun) {
        return { success: false, reason: 'dry-run', dryRun: true, audit, filledCount };
      }

      // Never submit an application whose required CV did not attach. Some
      // dropzone widgets (measured on Teamtailor) accept a programmatic file
      // and then manage it entirely in JS, so the input reports no file and
      // the submission would go out with no resume at all. Submitting is
      // irreversible, so a skip the manual queue can pick up beats a silent
      // CV-less application.
      if (audit.problems.some(p => p.kind === 'required-file-empty')) {
        return {
          success: false,
          reason: 'resume-upload-failed',
          audit,
          unresolved: ['required CV did not attach'],
        };
      }

      // If filling revealed a real interactive challenge, hand off to manual.
      if (await hasBlockingCaptcha(page)) {
        return { success: false, reason: 'captcha-detected-post-form', captcha: true };
      }

      const control = await findAdvanceControl(page);
      if (!control) {
        // Legacy text-matching sweep as a last resort before declaring defeat.
        if (await findAndClickSubmit(page)) break;
        return { success: false, reason: filledAnything ? 'no-submit-button-found' : 'no-form-fields-found' };
      }

      const urlBefore = page.url();
      await clickAdvanceControl(page, control);
      await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 1200));

      if (control === 'submit') break;

      // 'next' that changed nothing means the step didn't validate — surface
      // the field errors, repair them, and let the next iteration retry.
      const moved = page.url() !== urlBefore || (await findAdvanceControl(page)) !== 'next';
      if (!moved) {
        const repaired = await repairFromErrors(page, job);
        if (!repaired) return { success: false, reason: 'form-validation-error' };
      }
    }

    let outcome = await classifyOutcome(page);

    // One repair pass on a rejected submit. These forms reject for a single
    // unrecognised required field far more often than for anything structural,
    // and re-reading the page's own error text tells us exactly which one —
    // so this converts a permanent skip into an application most of the time.
    if (outcome === 'error') {
      const repaired = await repairFromErrors(page, job);
      if (repaired) {
        await clickAdvanceControl(page, 'submit');
        await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 1500));
        outcome = await classifyOutcome(page);
      }
    }

    if (outcome === 'success') return { success: true, reason: 'submitted', audit: lastAudit };
    if (outcome === 'error') {
      // Carry the audit out so a validation failure is diagnosable from the
      // run log instead of being an opaque reason string.
      const unresolved = (lastAudit?.problems || []).map(p => `${p.kind}:${p.label}`.slice(0, 60));
      return { success: false, reason: 'form-validation-error', audit: lastAudit, unresolved };
    }
    // No clear confirmation text — the click did register, so treat as a soft
    // success rather than silently dropping it; worth spot-checking in logs.
    return { success: true, reason: 'submitted-unconfirmed' };
  } catch (e) {
    return { success: false, reason: `error: ${e.message}` };
  } finally {
    await page.close().catch(() => {});
  }
}
