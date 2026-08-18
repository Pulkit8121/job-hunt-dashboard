// In-page helpers for the form controls that are NOT plain HTML elements.
//
// generic-form-apply.js originally handled only <input>, <select> and
// <textarea>. That was true of Greenhouse/Lever/Ashby when it was written, but
// all three have since moved their demographic, location and yes/no questions
// onto custom React comboboxes — a <button> or text input with
// role="combobox" that pops a role="listbox" of <div role="option">. Those are
// invisible to a `document.querySelectorAll('select')` sweep, so they were
// silently left blank, and since they are usually the *required* fields, the
// submit bounced. That is what the 73 "form-validation-error" and 72
// "no-submit-button-found" skips in the database mostly are.
//
// Everything here is written as a string-callable browser function via
// page.evaluate, so there is no serialisation of closures.

// Finds custom comboboxes and tags them, returning descriptors. Deliberately
// excludes anything already covered by the native-element sweep.
export async function extractComboboxes(page, startIndex = 0) {
  return page.evaluate((start) => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none';
    };

    function labelFor(el) {
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const t = labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
        if (t) return t;
      }
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l?.textContent.trim()) return l.textContent.trim();
      }
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
      const group = el.closest('[class*="field" i], [class*="question" i], fieldset, [role="group"]');
      const heading = group?.querySelector('label, legend, [class*="label" i]');
      if (heading?.textContent.trim()) return heading.textContent.trim();
      return el.getAttribute('placeholder') || el.getAttribute('name') || '';
    }

    const nodes = Array.from(document.querySelectorAll(
      '[role="combobox"], [aria-haspopup="listbox"], [class*="select__control" i], [class*="Select-control" i]'
    ));

    const out = [];
    const seen = new Set();
    let i = start;
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      // A react-select renders BOTH a wrapper with the class and an inner
      // role="combobox" input — tagging both would answer the same question
      // twice and the second click would land on an already-closed menu.
      const anchor = el.closest('[class*="select__control" i], [class*="Select-control" i]') || el;
      if (seen.has(anchor)) continue;
      seen.add(anchor);

      const ref = `agent-combo-${i++}`;
      anchor.setAttribute('data-agent-ref', ref);
      out.push({
        refId: ref,
        label: labelFor(el) || labelFor(anchor),
        kind: 'combobox',
        required: anchor.getAttribute('aria-required') === 'true'
          || el.getAttribute('aria-required') === 'true'
          || !!anchor.closest('[class*="required" i]'),
      });
    }
    return out;
  }, startIndex);
}

// Opens a combobox and returns the option labels it revealed. Returns [] if it
// wouldn't open, so the caller can skip rather than blind-type into it.
export async function openComboboxOptions(page, refId) {
  const control = await page.$(`[data-agent-ref="${refId}"]`);
  if (!control) return [];
  try {
    await control.scrollIntoView().catch(() => {});
    await control.click({ delay: 20 }).catch(() => {});
  } finally {
    await control.dispose();
  }
  // React menus mount on a microtask + transition; poll briefly instead of a
  // fixed sleep so a fast menu doesn't cost us 600ms on every field.
  for (let attempt = 0; attempt < 6; attempt++) {
    const options = await page.evaluate(() => {
      const menu = [...document.querySelectorAll('[role="listbox"], [class*="select__menu" i], [class*="Select-menu" i]')]
        .find(m => m.getBoundingClientRect().height > 0);
      if (!menu) return [];
      return [...menu.querySelectorAll('[role="option"], [class*="select__option" i], li')]
        .map(o => (o.textContent || '').trim())
        .filter(Boolean)
        .slice(0, 60);
    }).catch(() => []);
    if (options.length) return options;
    await new Promise(r => setTimeout(r, 120));
  }
  return [];
}

// Clicks the open menu's option whose text matches `label`. Falls back to
// typing + Enter, which is how react-select handles async/searchable menus
// where the option isn't in the DOM until you filter for it.
export async function chooseComboboxOption(page, refId, label) {
  const clicked = await page.evaluate((text) => {
    const menu = [...document.querySelectorAll('[role="listbox"], [class*="select__menu" i], [class*="Select-menu" i]')]
      .find(m => m.getBoundingClientRect().height > 0);
    if (!menu) return false;
    const options = [...menu.querySelectorAll('[role="option"], [class*="select__option" i], li')];
    const want = text.trim().toLowerCase();
    const hit = options.find(o => (o.textContent || '').trim().toLowerCase() === want)
      || options.find(o => (o.textContent || '').trim().toLowerCase().includes(want));
    if (!hit) return false;
    hit.scrollIntoView({ block: 'nearest' });
    hit.click();
    return true;
  }, label).catch(() => false);

  if (clicked) return true;

  const input = await page.$(`[data-agent-ref="${refId}"] input, [data-agent-ref="${refId}"]`);
  if (!input) return false;
  try {
    await input.type(label.slice(0, 40), { delay: 15 });
    await new Promise(r => setTimeout(r, 400));
    await page.keyboard.press('Enter');
    return true;
  } catch {
    return false;
  } finally {
    await input.dispose();
  }
}

// Required fields that are still empty. Used as a pre-submit gate: submitting
// with these unfilled is a guaranteed bounce, and the bounce is what used to
// get recorded as a permanent skip.
export async function findUnfilledRequired(page) {
  return page.evaluate(() => {
    const out = [];
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4 && el.offsetParent !== null;
    };
    const labelOf = (el) => {
      const g = el.closest('[class*="field" i], [class*="question" i], fieldset, [role="group"]');
      return (g?.querySelector('label, legend')?.textContent
        || el.getAttribute('aria-label')
        || el.getAttribute('name') || '').trim();
    };
    for (const el of document.querySelectorAll('[required], [aria-required="true"]')) {
      if (el.disabled || !isVisible(el)) continue;
      if (el.type === 'checkbox' || el.type === 'radio') {
        const group = el.name ? document.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`) : [el];
        if ([...group].some(g => g.checked)) continue;
      } else if (el.value && el.value.trim()) {
        continue;
      }
      out.push({ ref: el.getAttribute('data-agent-ref') || null, label: labelOf(el) });
    }
    return out;
  }).catch(() => []);
}

// Field-level validation messages after a rejected submit, so the next attempt
// can target exactly what the form complained about instead of refilling
// everything blindly.
export async function readFieldErrors(page) {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll(
      '[aria-invalid="true"], [class*="error" i], [role="alert"], [class*="invalid" i]'
    )];
    const out = [];
    for (const n of nodes) {
      if (n.getBoundingClientRect().height === 0) continue;
      const message = (n.textContent || '').trim().slice(0, 160);
      if (!message) continue;
      const field = n.closest('[class*="field" i], [class*="question" i], fieldset');
      const control = field?.querySelector('[data-agent-ref]');
      out.push({ ref: control?.getAttribute('data-agent-ref') || null, message });
      if (out.length >= 25) break;
    }
    return out;
  }).catch(() => []);
}

// Submit/next button vocabulary, including the non-English wording used by the
// EU-heavy boards. Measured directly: Recruitee's submit reads "Versturen"
// (Dutch) and Teamtailor's "Envoyer ma candidature" (French), so an
// English-only matcher reported no-submit-button-found on forms that were
// perfectly fillable.
const SUBMIT_WORDS = [
  'submit', 'submit application', 'send application', 'apply', 'finish', 'send',
  'versturen', 'verzenden', 'solliciteer',                       // nl
  'envoyer', 'envoyer ma candidature', 'postuler', 'soumettre',  // fr
  'senden', 'bewerbung absenden', 'absenden', 'bewerben',        // de
  'enviar', 'enviar candidatura', 'postular',                    // es/pt
  'invia', 'invia candidatura', 'candidati',                     // it
  'skicka', 'send inn', 'ansok',                                 // sv/no
];
const NEXT_WORDS = [
  'next', 'continue', 'save and continue', 'proceed',
  'volgende', 'suivant', 'weiter', 'siguiente', 'avanti', 'nasta',
];

// Consent overlays sit on top of the form and swallow clicks — on a JazzHR
// posting the only visible enabled buttons were "Allow" and "Reject All",
// with the entire application form behind them.
//
// This ONLY ever clicks a decline/reject control, never an accept one. That is
// both the privacy-preserving choice and enough to clear the overlay.
const CONSENT_DECLINE = [
  'reject all', 'reject', 'decline', 'decline all', 'only necessary',
  'necessary only', 'essential only', 'refuser', 'refuser les cookies facultatifs',
  'ablehnen', 'alle ablehnen', 'weigeren', 'rechazar', 'rifiuta',
];
const CONSENT_CONTEXT = /cookie|consent|privacy|gdpr|tracking/i;

// Dismisses a cookie/consent banner by DECLINING it. Returns the label it
// clicked, or null. Never accepts.
export async function dismissConsentBanner(page) {
  return page.evaluate((declineWords, contextSrc) => {
    const context = new RegExp(contextSrc, 'i');
    const controls = [...document.querySelectorAll('button, input[type="submit"], [role="button"], a')]
      .filter(b => !b.disabled && b.offsetParent !== null && b.getBoundingClientRect().height > 0);

    for (const el of controls) {
      const text = (el.textContent || el.value || '').trim().toLowerCase();
      if (!text || !declineWords.includes(text)) continue;
      // Only act inside something that actually looks like a consent widget,
      // so a "Decline" answer *inside the application form* is never clicked.
      const banner = el.closest('[class*="cookie" i], [class*="consent" i], [id*="cookie" i], [id*="consent" i], [aria-label*="cookie" i], dialog, [role="dialog"]');
      const looksLikeConsent = banner || context.test(el.closest('div,section,footer')?.textContent?.slice(0, 400) || '');
      if (!looksLikeConsent) continue;
      el.click();
      return text;
    }
    return null;
  }, CONSENT_DECLINE, CONSENT_CONTEXT.source).catch(() => null);
}

// Advances a multi-step form. Workday, SmartRecruiters, Workable and an
// increasing share of Greenhouse forms paginate; the old single-pass filler
// looked for a Submit button on page 1, never found one, and recorded
// "no-submit-button-found". Returns 'submit' | 'next' | null WITHOUT clicking,
// so the caller decides.
export async function findAdvanceControl(page) {
  return page.evaluate((submitWords, nextWords) => {
    const buttons = [...document.querySelectorAll('button, input[type="submit"], [role="button"]')]
      .filter(b => !b.disabled && b.offsetParent !== null && b.getBoundingClientRect().height > 0);
    // Strip accents so "Envoyer ma candidature" and "Nasta" match regardless
    // of how the page spells them.
    const textOf = (b) => (b.textContent || b.value || '').trim().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const startsWithAny = (t, words) => words.some(w => t === w || t.startsWith(w + ' '));

    // Submit wins over Next when both are present — the last page of a wizard
    // often keeps a disabled-looking Back/Next pair alongside the real submit.
    const submit = buttons.find(b => startsWithAny(textOf(b), submitWords));
    if (submit) return 'submit';
    const next = buttons.find(b => startsWithAny(textOf(b), nextWords));
    if (next) return 'next';
    return null;
  }, SUBMIT_WORDS, NEXT_WORDS).catch(() => null);
}

export async function clickAdvanceControl(page, kind) {
  return page.evaluate((want, submitWords, nextWords) => {
    const buttons = [...document.querySelectorAll('button, input[type="submit"], [role="button"]')]
      .filter(b => !b.disabled && b.offsetParent !== null && b.getBoundingClientRect().height > 0);
    const textOf = (b) => (b.textContent || b.value || '').trim().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const words = want === 'submit' ? submitWords : nextWords;
    const btn = buttons.find(b => {
      const t = textOf(b);
      return words.some(w => t === w || t.startsWith(w + ' '));
    });
    if (!btn) return false;
    btn.scrollIntoView({ block: 'center' });
    btn.click();
    return true;
  }, kind, SUBMIT_WORDS, NEXT_WORDS).catch(() => false);
}
