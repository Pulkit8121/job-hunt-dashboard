// ATS-agnostic Puppeteer form-filling engine. Greenhouse, Lever, and Ashby all
// render a normal HTML form once you land on the job's apply page — rather
// than hardcoding a selector map per ATS (brittle, breaks on redesigns), this
// reads whatever fields the page actually has and fills them via
// application-agent.js. Aborts (does not attempt to solve) on any detected
// CAPTCHA/bot-challenge.
import path from 'path';
import { answerField } from './application-agent.js';
import { captchaSolver } from './captcha-solver.js';

const RESUME_PATH = process.env.RESUME_PATH || path.join(process.cwd(), 'data', 'resume.pdf');
const NAV_TIMEOUT = 25000;

async function hasCaptcha(page) {
  return page.evaluate(() => {
    const html = document.documentElement.innerHTML.toLowerCase();
    if (html.includes('recaptcha') || html.includes('hcaptcha') || html.includes('cf-turnstile') || html.includes('cf-challenge')) return true;
    return !!document.querySelector('iframe[src*="captcha" i], iframe[title*="captcha" i], iframe[src*="turnstile" i]');
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

// Returns { success, reason, captcha? }
export async function applyToPortalJob(browser, job) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.goto(job.link, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
    await page.waitForSelector('form, input, textarea', { timeout: 10000 }).catch(() => {});

    if (await hasCaptcha(page)) {
      // Initialize CAPTCHA solver - now with nodriver support
      await captchaSolver.initialize();
      
      console.log('🔍 CAPTCHA detected on initial load - attempting to solve');
      
      // Try to solve the CAPTCHA using enhanced methods
      const solution = await captchaSolver.handleCaptcha(page, 'image');
      
      if (solution) {
        console.log('✅ CAPTCHA successfully solved:', solution);
        
        // Submit the solution 
        const submitted = await captchaSolver.submitSolution(page, solution);
        
        if (submitted) {
          console.log('Submitted CAPTCHA solution, continuing with form filling');
          
          // Wait for the page to reload after CAPTCHA submission
          await page.waitForLoadState('networkidle2');
          
          // Retry form field extraction after CAPTCHA handling
          const fields = await extractFields(page);
          if (!fields.length) {
            return { success: false, reason: 'no-form-fields-found-after-captcha' };
          }
          
        } else {
          // If we couldn't submit the solution, still report failure
          return { success: false, reason: 'captcha-solution-submission-failed', captcha: solution };
        }
      } else {
        console.log('❌ CAPTCHA could not be solved automatically');
        return { success: false, reason: 'captcha-detected', captcha: true };
      }
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

    // Check for CAPTCHA after filling the form
    if (await hasCaptcha(page)) {
      console.log('🔍 CAPTCHA detected after form filling - attempting to solve');
      
      const solution = await captchaSolver.handleCaptcha(page, 'image');
      if (solution) {
        // Submit the solution 
        const submitted = await captchaSolver.submitSolution(page, solution);
        
        if (submitted) {
          // Wait for page reload with updated state
          await page.waitForLoadState('networkidle2');
          console.log('✅ CAPTCHA after form submission solved successfully');
        } else {
          return { success: false, reason: 'captcha-solution-submission-failed-post-form', captcha: solution };
        }
      } else {
        return { success: false, reason: 'captcha-detected-post-form', captcha: true };
      }
    }

    const clicked = await findAndClickSubmit(page);
    if (!clicked) {
      return { success: false, reason: 'no-submit-button-found' };
    }

    await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));

    // Final CAPTCHA check after submission
    if (await hasCaptcha(page)) {
      console.log('🔍 CAPTCHA detected after form submission - attempting to solve');
      
      const solution = await captchaSolver.handleCaptcha(page, 'image');
      if (solution) {
        const submitted = await captchaSolver.submitSolution(page, solution);
        if (submitted) {
          await page.waitForLoadState('networkidle2');
          console.log('✅ CAPTCHA after final submission solved successfully');
        } else {
          return { success: false, reason: 'captcha-solution-submission-failed-final', captcha: solution };
        }
      } else {
        return { success: false, reason: 'captcha-detected-post-submit', captcha: true };
      }
    }

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
