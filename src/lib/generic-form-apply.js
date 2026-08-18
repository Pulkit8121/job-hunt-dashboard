// ATS-agnostic Puppeteer form-filling engine. Greenhouse, Lever, and Ashby all
// render a normal HTML form once you land on the job's apply page — rather
// than hardcoding a selector map per ATS (brittle, breaks on redesigns), this
// reads whatever fields the page actually has and fills them via
// application-agent.js. Aborts (does not attempt to solve) on any detected
// CAPTCHA/bot-challenge.
import path from 'path';
import { answerField } from './application-agent.js';
import {
  extractComboboxes, openComboboxOptions, chooseComboboxOption,
  findUnfilledRequired, readFieldErrors, findAdvanceControl, clickAdvanceControl,
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
      const group = el.closest('[class*="field" i], [class*="question" i], fieldset, [role="group"]');
      if (group) {
        const heading = group.querySelector('label, legend, [class*="label" i]');
        if (heading && heading.textContent.trim() && heading !== el) return heading.textContent.trim();
      }
      return el.placeholder || el.name || '';
    }

    const results = [];
    const seenGroups = new Set();
    let i = 0;

    document.querySelectorAll('input, select, textarea').forEach((el) => {
      if (el.disabled || el.readOnly) return;
      if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button' || el.type === 'image') return;

      const refId = `agent-field-${i++}`;

      if (el.type === 'radio' || el.type === 'checkbox') {
        const groupKey = el.name || refId;
        if (seenGroups.has(groupKey)) return;
        seenGroups.add(groupKey);
        const group = el.name
          ? Array.from(document.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`))
          : [el];
        group.forEach((g, gi) => g.setAttribute('data-agent-ref', `${refId}-opt-${gi}`));
        results.push({
          refId,
          label: labelFor(el),
          kind: 'choice',
          multi: el.type === 'checkbox' && group.length > 1,
          options: group.map((g, gi) => ({ ref: `${refId}-opt-${gi}`, label: labelFor(g) })),
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
        results.push({ refId, label: labelFor(el), kind: 'file' });
      } else {
        results.push({ refId, label: labelFor(el), kind: el.tagName === 'TEXTAREA' ? 'textarea' : 'text' });
      }
    });

    return results;
  });
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

async function uploadResume(page, refId) {
  const handle = await page.$(`[data-agent-ref="${refId}"]`);
  if (!handle) return false;
  try {
    await handle.uploadFile(RESUME_PATH);
    return true;
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
function shouldUploadResume(field, fileFieldCount) {
  if (/resume|cv\b|curriculum/i.test(field.label)) return true;
  if (/cover.?letter|photo|portfolio|transcript/i.test(field.label)) return false;
  return fileFieldCount === 1;
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
async function ensureApplyForm(page, job) {
  if (await pageHasFillableFields(page)) return;

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
  const fileFieldCount = native.filter(f => f.kind === 'file').length;

  for (const field of native) {
    if (!wanted(field.refId)) continue;

    if (field.kind === 'file') {
      if (shouldUploadResume(field, fileFieldCount) && await uploadResume(page, field.refId)) filled++;
      continue;
    }

    if (field.kind === 'choice') {
      const options = field.options.map(o => o.label);
      const answer = await answerField({ label: field.label, kind: 'choice', options }, job);
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

    const answer = await answerField({ label: field.label, kind: field.kind }, job);
    if (answer) {
      await fillTextField(page, field.refId, answer).catch(() => {});
      filled++;
    }
  }

  // Comboboxes have to be opened before their options exist in the DOM, so
  // they can't be answered from the same static extract pass as the rest.
  for (const combo of combos) {
    if (!wanted(combo.refId)) continue;
    const options = await openComboboxOptions(page, combo.refId);
    if (!options.length) continue;
    const answer = await answerField({ label: combo.label, kind: 'choice', options }, job);
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
export async function applyToPortalJob(browser, job) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.goto(job.link, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
    await page.waitForSelector('form, input, textarea', { timeout: 10000 }).catch(() => {});

    // Lever/Ashby posting pages don't carry the form — route to the real apply form.
    await ensureApplyForm(page, job);

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

    for (let step = 1; step <= MAX_STEPS; step++) {
      const filledCount = await fillVisibleFields(page, job);
      if (filledCount > 0) filledAnything = true;

      if (step === 1 && filledCount === 0) {
        const anyFields = await pageHasFillableFields(page);
        if (!anyFields) return { success: false, reason: 'no-form-fields-found' };
      }

      // A required field left blank is a guaranteed bounce. Ask the agent again
      // with the validation label as the prompt before spending the submit.
      await fillRequiredGaps(page, job);

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

    if (outcome === 'success') return { success: true, reason: 'submitted' };
    if (outcome === 'error') return { success: false, reason: 'form-validation-error' };
    // No clear confirmation text — the click did register, so treat as a soft
    // success rather than silently dropping it; worth spot-checking in logs.
    return { success: true, reason: 'submitted-unconfirmed' };
  } catch (e) {
    return { success: false, reason: `error: ${e.message}` };
  } finally {
    await page.close().catch(() => {});
  }
}
