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
        // react-select puts the required attribute on a hidden proxy input
        // beside the control, not on the combobox itself — so checking only
        // aria-required reported every Greenhouse dropdown as optional and the
        // required-choice fallback never ran.
        required: anchor.getAttribute('aria-required') === 'true'
          || el.getAttribute('aria-required') === 'true'
          || !!anchor.closest('[class*="required" i]')
          // The proxy lives in the select *container*, which is not the
          // control's immediate parent — measured one hop further up, so a
          // single-level lookup found nothing and reported every Greenhouse
          // dropdown optional. Walk up a bounded number of levels instead.
          || (() => {
            for (let n = anchor, hops = 0; n && hops < 4; n = n.parentElement, hops++) {
              if (n.querySelector('input[required][aria-hidden="true"], input[required][tabindex="-1"]')) return true;
            }
            return false;
          })(),
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
// NOTE: bare "apply" is deliberately absent. Greenhouse renders a decorative
// "Apply" button at the top of the posting that only scrolls to the form —
// matching it meant the run clicked that, never submitted, and still reported
// success. Verified at the network level: the only POSTs were analytics and
// the S3 resume upload, with no request to any application endpoint, and the
// page ended back on the job description. Real submit controls say "Submit
// Application" or are a genuine type=submit inside the form.
const SUBMIT_WORDS = [
  'submit', 'submit application', 'send application', 'finish', 'send',
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

    // Text first: Ashby renders "Upload File" as type=submit and Breezy's real
    // submit is type="button", so the element type alone is not a reliable
    // signal. With bare "apply" excluded from SUBMIT_WORDS the text match is.
    const submit = buttons.find(b => startsWithAny(textOf(b), submitWords))
      || buttons.find(b => b.closest('form') && b.type === 'submit');
    if (submit) return 'submit';
    const next = buttons.find(b => startsWithAny(textOf(b), nextWords));
    if (next) return 'next';
    return null;
  }, SUBMIT_WORDS, NEXT_WORDS).catch(() => null);
}

export async function clickAdvanceControl(page, kind) {
  // Tag the target in-page, then click it for REAL through Puppeteer.
  //
  // A synthetic el.click() from page.evaluate carries isTrusted:false, and
  // modern ATS front-ends ignore it for submission — the same failure already
  // documented for Naukri's apply button in naukri.js. Ashby logged every
  // ApiSetFormValue mutation for the filled fields and then no submit mutation
  // at all, because the click never counted.
  const tagged = await page.evaluate((want, submitWords, nextWords) => {
    const buttons = [...document.querySelectorAll('button, input[type="submit"], [role="button"]')]
      .filter(b => !b.disabled && b.offsetParent !== null && b.getBoundingClientRect().height > 0);
    const textOf = (b) => (b.textContent || b.value || '').trim().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const words = want === 'submit' ? submitWords : nextWords;

    // Prefer an explicit text match over a bare type=submit: Ashby renders its
    // "Upload File" controls as type=submit too, and Breezy's real submit is
    // type="button". Text is the reliable signal once bare "apply" is excluded.
    const byText = buttons.find(b => {
      const t = textOf(b);
      return words.some(w => t === w || t.startsWith(w + ' '));
    });
    const btn = byText
      || (want === 'submit' && buttons.find(b => b.closest('form') && b.type === 'submit'));
    if (!btn) return null;
    btn.setAttribute('data-agent-submit', '1');
    return (btn.textContent || btn.value || '').trim().slice(0, 40);
  }, kind, SUBMIT_WORDS, NEXT_WORDS).catch(() => null);

  if (!tagged) return false;

  const handle = await page.$('[data-agent-submit="1"]');
  if (!handle) return false;
  try {
    await handle.scrollIntoView().catch(() => {});
    await new Promise(r => setTimeout(r, 250));

    // A real click lands at the element's centre point, and Puppeteer does not
    // complain if something else is on top — the click silently goes to the
    // overlay. Ashby reported a successful submit click while firing no submit
    // mutation, because an open combobox menu left over from filling was
    // covering the button. Verify the button is genuinely the topmost element
    // there, and clear overlays if it is not.
    const isTopmost = () => handle.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
    }).catch(() => true);

    if (!await isTopmost()) {
      await page.keyboard.press('Escape').catch(() => {});   // close any open menu
      await page.evaluate(() => document.body.click()).catch(() => {});
      await new Promise(r => setTimeout(r, 300));
      await handle.scrollIntoView().catch(() => {});
      await new Promise(r => setTimeout(r, 200));
    }

    if (await isTopmost()) {
      await handle.click({ delay: 30 });
      return true;
    }

    // Still covered. A synthetic el.click() is NOT an acceptable fallback
    // here: it carries isTrusted:false, Ashby ignores it for submission, and
    // reporting success on it is how a covered button produced "clicked=true"
    // with no submit mutation at all. Report the failure instead so the caller
    // can surface it rather than recording a phantom submission.
    return false;
  } catch {
    // Covered or detached — fall back to the synthetic click rather than
    // losing the attempt entirely.
    await page.evaluate(el => el.click(), handle).catch(() => {});
    return true;
  } finally {
    await handle.evaluate(el => el.removeAttribute('data-agent-submit')).catch(() => {});
    await handle.dispose();
  }
}

// ── Post-fill audit ─────────────────────────────────────────────────────────
// Reads back what is ACTUALLY in the form after filling, rather than trusting
// that each write landed. This exists because a fill that reports success can
// still be wrong in ways only the finished form reveals: a value written to a
// React-controlled input and then reverted, one answer duplicated across
// several distinct questions, or a template placeholder submitted verbatim.
//
// Returns { problems: [{ ref, label, kind, detail }], filled, total }.
export async function auditFilledForm(page, { profileValues = [] } = {}) {
  return page.evaluate((profileVals) => {
    const problems = [];
    const isVisible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4 && el.offsetParent !== null;
    };
    const labelOf = (el) => {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l?.textContent.trim()) return l.textContent.trim();
      }
      if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
      const g = el.closest('[class*="field" i], [class*="question" i], fieldset');
      if (g && g.querySelectorAll('input:not([type=hidden]), select, textarea').length === 1) {
        return (g.querySelector('label, legend')?.textContent || '').trim();
      }
      return (el.name || '').trim();
    };

    // react-select renders a visually-hidden proxy input purely to carry
    // HTML5 required-validation on behalf of its combobox:
    //   <input required tabindex="-1" aria-hidden="true" class="…requiredInput">
    // It is not typeable and fills itself when the combobox is answered.
    // Reporting it directly produced a permanently unresolvable
    // "required-empty" with no label. Its emptiness is still a real signal —
    // it means the *combobox* is unanswered — so it is re-attributed below
    // rather than ignored.
    const isValidationProxy = (el) =>
      el.getAttribute('aria-hidden') === 'true' || el.tabIndex === -1;

    const all = [...document.querySelectorAll('input, select, textarea')]
      .filter(el => !el.disabled && !el.readOnly
        && !['hidden', 'submit', 'button', 'image'].includes(el.type));

    // Text that is decoration, not a question. Workable's label walk otherwise
    // returned "SVGs not supported by this browser." — an <svg> fallback node.
    const JUNK_LABEL = /svgs? not supported|^\s*$|^select\.{0,3}$|^loading/i;

    for (const el of all) {
      if (!isValidationProxy(el)) continue;
      const required = el.required || el.getAttribute('aria-required') === 'true';
      if (!required || (el.value || '').trim()) continue;

      // The proxy can lag its own combobox: Workable leaves it empty even
      // after a selection is made. Reporting that produces a problem the
      // repair loop can never resolve, so check the visible control first and
      // treat a combobox that clearly shows a selection as answered.
      const shell = el.closest('[class*="select" i], [class*="field" i]') || el.parentElement;
      // Class naming differs per ATS (react-select uses select__single-value,
      // Workable uses hashed module classes), so fall back to the control's
      // own rendered text minus the placeholder.
      const combo0 = shell?.querySelector('[role="combobox"], [class*="control" i]');
      const shown = (shell?.querySelector('[class*="singleValue" i], [class*="select__single-value" i]')?.textContent
        || combo0?.getAttribute('aria-label')
        || (combo0?.textContent || '').trim()
        || '').trim();
      if (shown && !/^select\.{0,3}$/i.test(shown)) continue;
      // Name the combobox this proxy belongs to, so the report points at
      // something answerable.
      const host = el.closest('[class*="select" i], [class*="field" i], [class*="question" i]') || el.parentElement;
      const combo = host?.querySelector('[role="combobox"], [class*="select__control" i]');
      // The visible label usually sits OUTSIDE the react-select container, so
      // walk up until a container that actually carries one.
      let labelNode = null;
      for (let n = el.parentElement, hops = 0; n && hops < 6; n = n.parentElement, hops++) {
        labelNode = n.querySelector(':scope > label, :scope > legend, :scope label');
        if (labelNode?.textContent?.trim()) break;
        labelNode = null;
      }
      let label = (labelNode?.textContent || '').trim();
      if (JUNK_LABEL.test(label)) label = '';
      label = label
        || (combo?.getAttribute('aria-label') || '').trim()
        || (shell?.getAttribute('aria-label') || '').trim();
      problems.push({
        ref: combo?.getAttribute('data-agent-ref') || null,
        label: label || '(unlabelled dropdown)',
        kind: 'required-choice-empty',
        detail: 'combobox not answered (react-select required proxy is empty)',
      });
    }

    const controls = all.filter(el => isVisible(el) && !isValidationProxy(el));

    let filled = 0;
    const textValues = new Map(); // value -> [labels] for duplicate detection

    for (const el of controls) {
      const label = labelOf(el);
      const ref = el.getAttribute('data-agent-ref') || null;
      const required = el.required || el.getAttribute('aria-required') === 'true';

      if (el.type === 'file') {
        if (el.files?.length) filled++;
        else if (required) problems.push({ ref, label, kind: 'required-file-empty', detail: 'no file attached' });
        continue;
      }

      if (el.type === 'checkbox' || el.type === 'radio') {
        const group = el.name ? [...document.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`)] : [el];
        if (group.some(g => g.checked)) filled++;
        else if (required) problems.push({ ref, label, kind: 'required-choice-empty', detail: 'nothing selected' });
        continue;
      }

      const value = (el.value || '').trim();
      if (!value) {
        if (required) problems.push({ ref, label, kind: 'required-empty', detail: 'left blank' });
        continue;
      }
      filled++;

      // A placeholder that survived into the form is worse than a blank.
      if (/\[[^\]]{2,40}\]|\{\{|<[a-z ]+>/i.test(value)) {
        problems.push({ ref, label, kind: 'placeholder-value', detail: value.slice(0, 60) });
        continue;
      }

      // Free text landing in a field that wants a specific format.
      if (el.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
        problems.push({ ref, label, kind: 'bad-email', detail: value.slice(0, 40) });
      }
      // Count digits overall rather than requiring a 6-digit run: intl phone
      // widgets render "+91 82995 59013", which is correct but has no long
      // consecutive run. A wrong country code is caught separately below.
      if (el.type === 'tel' || /phone|mobile|telefon|telefoon|téléphone/i.test(label)) {
        const digits = value.replace(/\D/g, '');
        if (digits.length < 8) {
          problems.push({ ref, label, kind: 'bad-phone', detail: value.slice(0, 40) });
        } else if (profileVals.some(v => /^\+?\d/.test(v))) {
          // The widget prepends whatever country is selected. If the rendered
          // number does not start with the profile's own country code, the
          // country selector picked the wrong entry — measured live as
          // "+246 82995 59013" (British Indian Ocean Territory) for an Indian
          // number, which would have been submitted as an unreachable phone.
          const want = (profileVals.find(v => /^\+\d/.test(v)) || '').replace(/\D/g, '');
          if (want && !digits.startsWith(want.slice(0, 2)) && /^\+/.test(value)) {
            problems.push({ ref, label, kind: 'wrong-country-code', detail: value.slice(0, 40) });
          }
        }
      }
      if (el.type === 'number' && Number.isNaN(Number(value))) {
        problems.push({ ref, label, kind: 'bad-number', detail: value.slice(0, 40) });
      }
      // A sentence in a field that clearly wants a short token.
      if (/^(year|month|day|zip|postal|pincode)/i.test(label) && value.length > 20) {
        problems.push({ ref, label, kind: 'overlong-value', detail: value.slice(0, 50) });
      }

      // Same long answer reused across different questions is the signature of
      // the label-collision bug: distinct fields resolving to one label.
      if (value.length > 25 && !profileVals.includes(value)) {
        if (!textValues.has(value)) textValues.set(value, []);
        textValues.get(value).push({ ref, label });
      }
    }

    for (const [value, uses] of textValues) {
      if (uses.length < 2) continue;
      const distinctLabels = new Set(uses.map(u => u.label));
      if (distinctLabels.size < 2) continue; // genuinely the same question twice
      for (const u of uses) {
        problems.push({ ref: u.ref, label: u.label, kind: 'duplicated-answer', detail: value.slice(0, 45) });
      }
    }

    return { problems, filled, total: controls.length };
  }, profileValues).catch(() => ({ problems: [], filled: 0, total: 0 }));
}
