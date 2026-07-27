// ATS-agnostic Puppeteer form-filling engine. Greenhouse, Lever, and Ashby all
// render a normal HTML form once you land on the job's apply page — rather
// than hardcoding a selector map per ATS (brittle, breaks on redesigns), this
// reads whatever fields the page actually has and fills them via
// application-agent.js. Aborts (does not attempt to solve) on any detected
// CAPTCHA/bot-challenge.
import path from 'path';
import { answerField } from './application-agent.js';

const RESUME_PATH = process.env.RESUME_PATH || path.join(process.cwd(), 'data', 'resume.pdf');
const NAV_TIMEOUT = 25000;

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

    const fields = await extractFields(page);
    if (!fields.length) {
      return { success: false, reason: 'no-form-fields-found' };
    }

    for (const field of fields) {
      if (field.kind === 'file') {
        if (/resume|cv\b/i.test(field.label)) await uploadResume(page, field.refId);
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
        continue;
      }

      const answer = await answerField({ label: field.label, kind: field.kind }, job);
      if (answer) await fillTextField(page, field.refId, answer).catch(() => {});
    }

    // If filling revealed a real interactive challenge, hand off to manual.
    if (await hasBlockingCaptcha(page)) {
      return { success: false, reason: 'captcha-detected-post-form', captcha: true };
    }

    const clicked = await findAndClickSubmit(page);
    if (!clicked) {
      return { success: false, reason: 'no-submit-button-found' };
    }

    await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    const text = await detectOutcomeText(page);
    const looksSuccessful = /thank you|application (?:received|submitted|complete)|successfully applied|we('| ha)ve received your application/.test(text);
    const looksError = /required field|please fill|error|something went wrong|invalid/.test(text);

    if (looksSuccessful && !looksError) {
      return { success: true, reason: 'submitted' };
    }
    if (looksError) {
      return { success: false, reason: 'form-validation-error' };
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
