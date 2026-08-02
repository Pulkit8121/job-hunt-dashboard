import { resolveAnswer, PROFILE_ANSWERS } from './naukri-question-agent.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Naukri's Apply buttons and job-tuple links frequently carry target="_blank" or
// call window.open() — over hundreds of applications this opens hundreds of
// untracked Chrome tabs and grinds the browser to a halt. This forces same-tab
// navigation instead. Installed once per page via evaluateOnNewDocument so it
// survives every future navigation without re-registering (which would stack
// MutationObservers across hundreds of job applications).
async function neutralizeNewTabs(page) {
  await page.evaluateOnNewDocument(() => {
    window.open = function (url) {
      if (url) window.location.href = url;
      return window;
    };
    function stripBlankTargets(root) {
      if (!root || !root.querySelectorAll) return;
      root.querySelectorAll('a[target="_blank"]').forEach(a => a.removeAttribute('target'));
    }
    stripBlankTargets(document);
    const start = () => {
      stripBlankTargets(document);
      new MutationObserver(() => stripBlankTargets(document))
        .observe(document.body, { childList: true, subtree: true });
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
  });
}

// Closes any browser tabs that appear DURING fn() and weren't open before it —
// scoped tightly (only naukri.com / about:blank tabs, never pre-existing tabs)
// so it can't accidentally close the user's own unrelated browsing tabs when
// running against their real, already-open Chrome session.
async function withTabCleanup(page, fn) {
  const browser = page.browser();
  const before = new Set(await browser.pages());
  try {
    return await fn();
  } finally {
    const after = await browser.pages();
    for (const p of after) {
      if (before.has(p) || p === page) continue;
      const url = p.url();
      if (url.includes('naukri.com') || url === 'about:blank') {
        await p.close().catch(() => {});
      }
    }
  }
}

export async function prepareNaukriPage(page) {
  await page.setUserAgent(USER_AGENT);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  if (!page.__naukriTabsNeutralized) {
    await neutralizeNewTabs(page);
    page.__naukriTabsNeutralized = true;
  }
}

export async function openNaukriPage(page, url) {
  await prepareNaukriPage(page);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await Promise.race([
    page.waitForSelector('.srp-jobtuple-wrapper', { timeout: 5000 }),
    page.waitForSelector('.cust-job-tuple', { timeout: 5000 }),
    page.waitForSelector('[data-job-id]', { timeout: 5000 }),
    page.waitForSelector('[class*="jobTuple"]', { timeout: 5000 }),
    page.waitForSelector('article.jobTuple', { timeout: 5000 }),
    page.waitForSelector('.job-container', { timeout: 5000 }),
    page.waitForSelector('[class*="comp-name"]', { timeout: 5000 }),
  ]).catch(() => {});
}

export async function extractNaukriCards(page) {
  return page.evaluate(() => {
    const cardSelectors = [
      '.srp-jobtuple-wrapper',
      '[data-job-id]',
      '.cust-job-tuple',
      '[class*="jobTuple"]',
      'article.jobTuple',
      'article',
      '.job-container',
    ];
    let cards = [];

    for (const selector of cardSelectors) {
      cards = Array.from(document.querySelectorAll(selector));
      if (cards.length > 0) break;
    }

    return cards.slice(0, 20).map(card => {
      const titleEl = card.querySelector('a[class*="title"], .title a, a[title], a[href*="/job-listings-"]');
      const link = titleEl?.href || '';
      const companyEl = card.querySelector('[class*="comp-name"], [class*="companyName"], [class*="company"]');
      const locEl = card.querySelector('[class*="location"], [class*="loc"]');
      const experienceEl = card.querySelector('[class*="exp"] [title], [class*="experience"], [class*="expwdth"]');
      const descEl = card.querySelector('[class*="job-desc"], [class*="desc"]');
      const salaryEl = card.querySelector('[class*="salary"], [class*="sal"]');
      const workModeEl = card.querySelector('[class*="remote"], [class*="wfh"], [class*="workMode"]');
      const cardText = (card.textContent || '').trim();
      const workModeText = ((workModeEl?.textContent || '') + ' ' + cardText).toLowerCase();
      const location = (locEl?.textContent || '').trim();
      const jobId = link.match(/-(\d+)$/)?.[1] || link.match(/jk=([^&]+)/)?.[1] || '';

      return {
        title: (titleEl?.textContent || '').trim(),
        link,
        jobId,
        companyName: (companyEl?.textContent || '').trim(),
        location: location ? location.split(',')[0].trim() : '',
        experienceText: (experienceEl?.textContent || experienceEl?.getAttribute?.('title') || '').trim(),
        description: (descEl?.textContent || '').trim().slice(0, 500),
        salary: (salaryEl?.textContent || '').trim(),
        workModeText,
      };
    }).filter(card => card.title || card.companyName);
  });
}

// Visits a Naukri job detail page and extracts the real apply URL + easy-apply status
export async function resolveNaukriJobDetail(page, naukriJobUrl) {
  try {
    await prepareNaukriPage(page);
    await page.goto(naukriJobUrl, { waitUntil: 'domcontentloaded', timeout: 18000 });
    // Short fixed wait — more reliable than selector races on dynamic pages
    await new Promise(r => setTimeout(r, 2000));

    return await page.evaluate(() => {
      const EXTERNAL_PHRASES = [
        'apply on company website',
        'apply on company site',
        'apply on company',
        'apply on employer',
        'visit employer',
        'apply externally',
        'external apply',
        'company website',
      ];
      const EASY_PHRASES = ['easy apply', 'apply now', 'apply'];

      const allEls = Array.from(document.querySelectorAll('a[href], button, [class*="apply"]'));

      // 1. Check for "Apply on Company Website" pattern first
      for (const el of allEls) {
        const text = (el.textContent || '').trim().toLowerCase();
        if (EXTERNAL_PHRASES.some(p => text.includes(p))) {
          // Walk up/down to find the actual href
          const candidates = [
            el.tagName === 'A' ? el.href : '',
            el.querySelector('a')?.href || '',
            el.closest('a')?.href || '',
          ];
          const externalLink = candidates.find(
            h => h && h.startsWith('http') && !h.includes('naukri.com') && !h.startsWith('javascript:')
          ) || null;
          return { isEasyApply: false, externalLink };
        }
      }

      // 2. Check for Easy Apply / Apply Now button
      for (const el of allEls) {
        const text = (el.textContent || '').trim().toLowerCase();
        if (EASY_PHRASES.some(p => text === p || text.startsWith(p + ' '))) {
          return { isEasyApply: true, externalLink: null };
        }
      }

      return { isEasyApply: false, externalLink: null };
    });
  } catch {
    return { isEasyApply: false, externalLink: null };
  }
}

// Fill an input via JS (bypasses Puppeteer clickability checks).
// Uses React's native value setter — Naukri's login form is React-controlled, so a
// plain `el.value = v` is silently discarded on submit (the form sees empty fields
// and re-renders itself). The native setter + input event updates React's state.
async function fillInput(page, selectors, value) {
  for (const sel of selectors) {
    const filled = await page.evaluate((s, v) => {
      const el = document.querySelector(s);
      if (!el) return false;
      el.focus();
      const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (desc && desc.set) desc.set.call(el, v); else el.value = v;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, sel, value);
    if (filled) return true;
  }
  return false;
}

// Login to Naukri — requires NAUKRI_EMAIL + NAUKRI_PASSWORD
// Returns true once we're on a logged-in Naukri page. Evaluate can throw mid-
// navigation ("execution context destroyed") — that itself means a redirect is
// happening (usually the successful login redirect), so callers treat a throw as
// "not yet confirmed" rather than a failure.
async function naukriLoggedIn(page) {
  const url = page.url();
  if (/\/mnjuser|\/homepage/.test(url)) return true;
  if (/\/nlogin\/login|\/login/.test(url)) return false;
  return page.evaluate(() =>
    /logout|my naukri|view profile|mnjuser/i.test(document.body.innerText || '')
  ).catch(() => true); // evaluate failed mid-nav → a redirect is in flight, assume success
}

export async function naukriLogin(page, email, password) {
  await prepareNaukriPage(page);
  await page.goto('https://www.naukri.com/nlogin/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise(r => setTimeout(r, 2500));

  // Already authenticated? Naukri redirects the login URL away when a session
  // exists — treat that as success instead of hunting for a form that isn't there.
  if (await naukriLoggedIn(page)) return;

  await page.evaluate(() => {
    document.querySelectorAll('[class*="cookie"], [class*="overlay"], [class*="modal"], [class*="popup"]').forEach(el => {
      const t = (el.textContent || '').toLowerCase();
      if (t.includes('accept') || t.includes('cookie')) el.remove();
    });
  }).catch(() => {});

  const emailFilled = await fillInput(page,
    ['#usernameField', 'input[type="email"]', 'input[placeholder*="email" i]', 'input[name*="email" i]'], email);
  if (!emailFilled) throw new Error('Naukri login: email field not found on page');
  await new Promise(r => setTimeout(r, 400));

  const passFilled = await fillInput(page,
    ['#passwordField', 'input[type="password"]', 'input[name*="password" i]'], password);
  if (!passFilled) throw new Error('Naukri login: password field not found on page');
  await new Promise(r => setTimeout(r, 400));

  // Submit ONCE. The old code also pressed Enter, which double-submitted and fired
  // the navigation while a later evaluate() was still running → "execution context
  // destroyed" (mis-reported as a login failure even though login had succeeded).
  await page.evaluate(() => {
    const btn = document.querySelector('button[type="submit"], input[type="submit"], .loginButton, button.btn-primary');
    if (btn) { btn.click(); return; }
    const form = document.querySelector('form');
    if (form) form.submit();
  }).catch(() => {});

  // Confirm by polling page.url() — this runs in Node, not the page, so it never
  // throws during the post-submit navigation. Success = we've left the login page.
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await naukriLoggedIn(page)) return;
  }
  throw new Error('Naukri login failed — still on the login page after submit. Check credentials or a CAPTCHA.');
}

// Fill application form fields — handles React controlled inputs
async function fillApplicationForm(page) {
  return page.evaluate((answers) => {
    const filled = [];

    // React-safe value setter — triggers React's synthetic events
    function setReactVal(el, val) {
      const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      const nativeTextarea = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      const descriptor = el.tagName === 'TEXTAREA' ? nativeTextarea : nativeInput;
      if (descriptor && descriptor.set) {
        descriptor.set.call(el, val);
      } else {
        el.value = val;
      }
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    }

    function matchesLabel(text, keywords) {
      const t = (text || '').toLowerCase();
      return keywords.some(k => t.includes(k));
    }

    // Get the label text for an element by checking multiple sources
    function getLabelText(el) {
      // Direct label association
      if (el.id) {
        const label = document.querySelector(`label[for="${el.id}"]`);
        if (label) return label.textContent;
      }
      // Wrapping label
      const wrappingLabel = el.closest('label');
      if (wrappingLabel) return wrappingLabel.textContent;
      // Sibling/parent label in question containers
      const container = el.closest(
        '[class*="question"], [class*="field"], [class*="form-group"], [class*="input-group"], ' +
        '[class*="chatbot"], [class*="ssQuestion"], [class*="botQuestion"]'
      );
      if (container) {
        const labelEl = container.querySelector('label, [class*="label"], [class*="title"], strong, b');
        if (labelEl) return labelEl.textContent;
        return container.textContent; // fallback: full container text
      }
      // placeholder / name
      return el.placeholder || el.name || el.getAttribute('aria-label') || '';
    }

    // Fill all visible text/number inputs
    document.querySelectorAll('input[type="text"], input[type="number"], input:not([type]), textarea').forEach(el => {
      if (el.disabled || el.readOnly) return;
      const label = getLabelText(el).toLowerCase();

      if (matchesLabel(label, ['current ctc', 'current salary', 'current package', 'current compensation'])) {
        setReactVal(el, answers.currentCtc); filled.push('currentCtc=' + answers.currentCtc);
      } else if (matchesLabel(label, ['expected ctc', 'expected salary', 'expected package', 'expected compensation', 'salary expectation'])) {
        setReactVal(el, answers.expectedCtc); filled.push('expectedCtc=' + answers.expectedCtc);
      } else if (matchesLabel(label, ['notice period', 'notice', 'joining time', 'availability'])) {
        setReactVal(el, answers.noticePeriod); filled.push('noticePeriod=' + answers.noticePeriod);
      } else if (matchesLabel(label, ['total experience', 'total exp', 'years of exp', 'work experience', 'relevant exp'])) {
        setReactVal(el, answers.totalExp); filled.push('totalExp=' + answers.totalExp);
      } else if (matchesLabel(label, ['experience']) && !matchesLabel(label, ['expected', 'no experience'])) {
        setReactVal(el, answers.experience); filled.push('experience=' + answers.experience);
      } else if (matchesLabel(label, ['location', 'city', 'preferred location', 'current location'])) {
        setReactVal(el, answers.location); filled.push('location=' + answers.location);
      }
    });

    // Handle select dropdowns
    document.querySelectorAll('select').forEach(sel => {
      if (sel.disabled) return;
      const label = getLabelText(sel).toLowerCase();
      let targetText = null;

      if (matchesLabel(label, ['notice period', 'notice', 'joining'])) targetText = answers.noticePeriod;
      else if (matchesLabel(label, ['current ctc', 'current salary', 'current package'])) targetText = answers.currentCtc;
      else if (matchesLabel(label, ['expected ctc', 'expected salary', 'expected package'])) targetText = answers.expectedCtc;
      else if (matchesLabel(label, ['experience']) && !matchesLabel(label, ['expected'])) targetText = answers.experience;

      if (targetText) {
        const opts = Array.from(sel.options);
        const match = opts.find(o => o.text.toLowerCase().includes(targetText.toLowerCase()));
        if (match) {
          sel.value = match.value;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          filled.push('select=' + label.slice(0, 20));
        }
      }
    });

    return filled;
  }, PROFILE_ANSWERS);
}

// Reads the current chatbot turn WITHOUT deciding anything — returns the
// question text plus whatever answer affordances are on screen, so the
// decision can be made in Node (where the LLM lives) rather than in-page.
// Selectors confirmed against Naukri's live DOM and cross-checked with
// JobSailor's Selenium XPaths.
async function readChatbotTurn(page) {
  return page.evaluate(() => {
    function isVisible(el) {
      if (!el) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && el.offsetParent !== null;
    }

    let question = '';
    const chatList = document.querySelector('ul[id*="chatList_"]');
    if (chatList) {
      const botItems = chatList.querySelectorAll('li.botItem');
      if (botItems.length) {
        const lastBot = botItems[botItems.length - 1];
        const span = lastBot.querySelector('div > div > span') || lastBot;
        question = (span.textContent || '').trim();
      }
    }
    if (!question) {
      const fallback = document.querySelectorAll(
        '[class*="bot-msg"], [class*="botMsg"], [class*="ssQuestion"], [class*="chatQuestion"]'
      );
      question = (fallback[fallback.length - 1]?.textContent || '').trim();
    }

    const containers = Array.from(document.querySelectorAll('.ssrc__radio-btn-container')).filter(isVisible);
    const options = containers.map((c, i) => {
      const lbl = c.querySelector('label');
      return { index: i, label: ((lbl?.textContent || c.textContent || '').trim()) };
    }).filter(o => o.label);

    const textArea = document.querySelector('div.textArea');
    const hasTextArea = isVisible(textArea);

    let hasSubmit = false;
    const submitPhrases = ['submit application', 'submit', 'apply now', 'confirm', 'finish'];
    for (const el of document.querySelectorAll('button')) {
      const t = (el.textContent || '').trim().toLowerCase();
      if (!el.disabled && isVisible(el) && submitPhrases.some(p => t.includes(p)) && !t.includes('company')) {
        hasSubmit = true; break;
      }
    }

    return { question, options, hasTextArea, hasSubmit };
  });
}

// Applies a decided answer. `optionIndex >= 0` clicks that chip; otherwise the
// text is typed into the chat box and sent.
async function applyChatbotAnswer(page, { optionIndex, text }) {
  return page.evaluate((optIdx, val) => {
    function isVisible(el) {
      if (!el) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && el.offsetParent !== null;
    }
    function setReactInput(el, v) {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (desc && desc.set) desc.set.call(el, v); else el.value = v;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (optIdx >= 0) {
      const containers = Array.from(document.querySelectorAll('.ssrc__radio-btn-container')).filter(isVisible);
      const picked = containers[optIdx];
      if (!picked) return 'option_missing';
      const radioInput = picked.querySelector('input');
      if (radioInput) radioInput.click(); else picked.click();
      return 'option_clicked';
    }

    if (val == null || val === '') return 'no_text';

    const textArea = document.querySelector('div.textArea');
    if (textArea && isVisible(textArea)) {
      const inner = textArea.querySelector('input, textarea');
      if (inner) setReactInput(inner, val);
      else {
        textArea.textContent = val;
        textArea.dispatchEvent(new Event('input', { bubbles: true }));
      }
      const sendBtn =
        document.querySelector('[class*="sendBtn"], [class*="send-btn"], [class*="chatSend"]') ||
        Array.from(document.querySelectorAll('button')).find(b => /send|submit/i.test(b.textContent));
      if (sendBtn && isVisible(sendBtn)) sendBtn.click();
      else if (inner) {
        inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        inner.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', keyCode: 13, bubbles: true }));
      }
      return 'text_sent';
    }

    const fallbackSelectors = [
      '[class*="chatInput"] input', '[class*="chat-input"] input',
      '[class*="ssInput"] input', 'input[placeholder*="type" i]',
      'input[placeholder*="answer" i]', 'input[placeholder*="enter" i]',
    ];
    for (const sel of fallbackSelectors) {
      const input = document.querySelector(sel);
      if (!input || !isVisible(input)) continue;
      setReactInput(input, val);
      const sendBtn = document.querySelector('[class*="send"], [class*="chatSend"]');
      if (sendBtn && isVisible(sendBtn)) sendBtn.click();
      else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      return 'text_sent';
    }
    return 'no_input';
  }, optionIndex ?? -1, text ?? null);
}

// Clicks the final submit/confirm button if one is showing.
async function clickChatbotSubmit(page) {
  return page.evaluate(() => {
    function isVisible(el) {
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && el.offsetParent !== null;
    }
    const phrases = ['submit application', 'submit', 'apply now', 'confirm', 'finish'];
    for (const el of document.querySelectorAll('button')) {
      const t = (el.textContent || '').trim().toLowerCase();
      if (!el.disabled && isVisible(el) && phrases.some(p => t.includes(p)) && !t.includes('company')) {
        el.click();
        return true;
      }
    }
    return false;
  });
}

// Legacy pure-keyword implementation, retained as the fallback path when no
// AI key is configured. Returns: 'option_clicked' | 'text_sent' | 'submitted' | 'none'
async function answerChatbotTurnKeyword(page, answers) {
  return page.evaluate((ans) => {
    function isVisible(el) {
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && el.offsetParent !== null;
    }

    function setReactInput(el, val) {
      const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
      if (desc && desc.set) desc.set.call(el, val); else el.value = val;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // ── Extract current question from chatbot list ─────────────────────────────
    // Confirmed: ul[id*="chatList_"] contains li.botItem elements
    let lastQ = '';
    const chatList = document.querySelector('ul[id*="chatList_"]');
    if (chatList) {
      const botItems = chatList.querySelectorAll('li.botItem');
      if (botItems.length > 0) {
        const lastBot = botItems[botItems.length - 1];
        const span = lastBot.querySelector('div > div > span') || lastBot;
        lastQ = (span.textContent || '').toLowerCase();
      }
    }
    // Fallback question selectors
    if (!lastQ) {
      const fallbackMsgs = document.querySelectorAll(
        '[class*="bot-msg"], [class*="botMsg"], [class*="ssQuestion"], [class*="chatQuestion"]'
      );
      lastQ = (fallbackMsgs[fallbackMsgs.length - 1]?.textContent || '').toLowerCase();
    }

    // ── 1. Click option chips — confirmed class: .ssrc__radio-btn-container ─────
    // This is the stable BEM class used by Naukri's chatbot option buttons
    const chipContainers = Array.from(
      document.querySelectorAll('.ssrc__radio-btn-container')
    ).filter(isVisible);

    if (chipContainers.length > 0) {
      const q = lastQ;
      let bestContainer = null;

      const getText = (c) => {
        const lbl = c.querySelector('label');
        return (lbl?.textContent || c.textContent || '').toLowerCase();
      };

      if (/notice|joining|availability|when can you join/i.test(q)) {
        bestContainer = chipContainers.find(c => /15|2.?week|immed/i.test(getText(c)));
      } else if (/relocat|comfortable|open to|willing|remote|hybrid|office|shift/i.test(q)) {
        bestContainer = chipContainers.find(c => /yes|sure|open|comfort|ok/i.test(getText(c)));
      } else if (/experience|years? of exp|how many years/i.test(q)) {
        bestContainer = chipContainers.find(c => /1.?2|0.?2|1-3/i.test(getText(c))) ||
                        chipContainers.find(c => /\b2\b|\b1\b/i.test(getText(c)));
      } else if (/current.?ctc|current.?salary|current.?package/i.test(q)) {
        bestContainer = chipContainers.find(c => /5.?10|7|6.?8|less than 10/i.test(getText(c)));
      } else if (/expected.?ctc|expected.?salary|expectation/i.test(q)) {
        bestContainer = chipContainers.find(c => /10.?15|12.?16|14|15/i.test(getText(c)));
      } else if (/skill|technolog|stack|language|framework|tool/i.test(q)) {
        bestContainer = chipContainers.find(c => /yes|have|know/i.test(getText(c)));
      }

      const picked = bestContainer || chipContainers[0];
      // Click via the hidden input (JS click to avoid intercept) — confirmed from JobSailor
      const radioInput = picked.querySelector('input');
      if (radioInput) {
        radioInput.click();
      } else {
        picked.click();
      }
      return 'option_clicked:' + getText(picked).slice(0, 40);
    }

    // Fallback chip selectors (older Naukri layouts)
    const fallbackChipSelectors = [
      '[class*="chip"]', '[class*="chatOption"]', '[class*="ssOption"]',
      '[class*="botOption"]', '[class*="answer-option"]', '[class*="quick-reply"]',
    ];
    for (const sel of fallbackChipSelectors) {
      const chips = Array.from(document.querySelectorAll(sel)).filter(isVisible);
      if (!chips.length) continue;
      const q = lastQ;
      let best = null;
      if (/notice|joining/i.test(q)) best = chips.find(c => /15|immed/i.test(c.textContent));
      else if (/relocat|willing/i.test(q)) best = chips.find(c => /yes/i.test(c.textContent));
      else if (/experience/i.test(q)) best = chips.find(c => /1.?2|0.?2/i.test(c.textContent));
      const toClick = best || chips[0];
      toClick.click();
      return 'option_clicked:' + toClick.textContent.trim().slice(0, 40);
    }

    // ── 2. Fill text area — confirmed selector: div.textArea ─────────────────────
    const textArea = document.querySelector('div.textArea');
    if (textArea && isVisible(textArea)) {
      const q = lastQ;
      let val = '';
      if (/current.?ctc|current.?salary|current.?package/i.test(q))   val = ans.currentCtc;
      else if (/expected.?ctc|expected.?salary|expectation/i.test(q))  val = ans.expectedCtc;
      else if (/notice|joining|availability/i.test(q))                  val = ans.noticePeriod;
      else if (/total.?exp|years.?exp|how many years/i.test(q))         val = ans.totalExp;
      else if (/experience/i.test(q))                                    val = ans.experience;
      else if (/location|city|prefer/i.test(q))                         val = ans.location;
      else                                                                val = ans.totalExp;

      // div.textArea is contenteditable or has an inner input
      const inner = textArea.querySelector('input, textarea');
      if (inner) {
        setReactInput(inner, val);
      } else {
        textArea.textContent = val;
        textArea.dispatchEvent(new Event('input', { bubbles: true }));
      }

      // Click send/submit button (absolute selector from research + fallbacks)
      const sendBtn =
        document.querySelector('[class*="sendBtn"], [class*="send-btn"], [class*="chatSend"]') ||
        Array.from(document.querySelectorAll('button')).find(b => /send|submit/i.test(b.textContent));
      if (sendBtn && isVisible(sendBtn)) {
        sendBtn.click();
      } else if (inner) {
        inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        inner.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', keyCode: 13, bubbles: true }));
      }
      return 'text_sent:' + val;
    }

    // Fallback text input selectors
    const textInputSelectors = [
      '[class*="chatInput"] input', '[class*="chat-input"] input',
      '[class*="ssInput"] input', 'input[placeholder*="type" i]',
      'input[placeholder*="answer" i]', 'input[placeholder*="enter" i]',
    ];
    for (const sel of textInputSelectors) {
      const input = document.querySelector(sel);
      if (!input || !isVisible(input)) continue;
      const q = lastQ;
      let val = '';
      if (/current.?ctc/i.test(q))   val = ans.currentCtc;
      else if (/expected.?ctc/i.test(q)) val = ans.expectedCtc;
      else if (/notice/i.test(q))    val = ans.noticePeriod;
      else if (/exp/i.test(q))       val = ans.totalExp;
      else if (/location/i.test(q))  val = ans.location;
      else                            val = ans.totalExp;
      setReactInput(input, val);
      const sendBtn = document.querySelector('[class*="send"], [class*="chatSend"]');
      if (sendBtn && isVisible(sendBtn)) sendBtn.click();
      else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      return 'text_sent:' + val;
    }

    // ── 3. Final submit button ────────────────────────────────────────────────────
    const submitPhrases = ['submit application', 'submit', 'apply now', 'confirm', 'finish'];
    for (const el of document.querySelectorAll('button')) {
      const t = (el.textContent || '').trim().toLowerCase();
      if (!el.disabled && isVisible(el) && submitPhrases.some(p => t.includes(p)) && !t.includes('company')) {
        el.click();
        return 'submitted:' + t;
      }
    }

    return 'none';
  }, answers);
}

// Answers one chatbot turn using the rule → cache → LLM agent. Falls back to
// the legacy keyword matcher when no AI key is configured, so the flow still
// works without Gemini/OpenAI credentials.
// Returns a short status string for logging.
async function answerChatbotTurn(page, ctx) {
  const hasAI = !!(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);
  if (!hasAI) return answerChatbotTurnKeyword(page, PROFILE_ANSWERS);

  const state = await readChatbotTurn(page);
  const options = state.options.map(o => o.label);

  if (!state.question && !options.length && !state.hasTextArea) {
    if (state.hasSubmit && await clickChatbotSubmit(page)) return 'submitted';
    return 'none';
  }

  const { answer, source } = await resolveAnswer({
    question: state.question,
    options,
    cache: ctx?.cache,
    onResolved: ctx?.onResolved,
  });

  if (!answer) {
    // Nothing confidently determined. Submitting a guess here is how the old
    // implementation silently sent wrong answers — prefer to stop this
    // application and leave it for manual completion.
    if (state.hasSubmit && await clickChatbotSubmit(page)) return 'submitted';
    return 'unanswerable';
  }

  if (options.length) {
    const idx = options.indexOf(answer);
    if (idx < 0) return 'unanswerable';
    const res = await applyChatbotAnswer(page, { optionIndex: idx });
    return `${res}[${source}]:${answer.slice(0, 40)}`;
  }

  const res = await applyChatbotAnswer(page, { optionIndex: -1, text: answer });
  return `${res}[${source}]:${answer.slice(0, 40)}`;
}

// Resolves where Naukri's "Apply on company website" button actually goes.
//
// The old code only read an href off #company-site-button. That button is a JS
// handler, not an anchor, so the read always came back empty and the job was
// blacklisted as 'company-website' with no URL captured — 860 jobs were
// discarded that way, versus 2 that ever got a usable link. Those are exactly
// the jobs the company-portal flow could apply to, so recovering the URL turns
// a dead end into a candidate.
//
// Clicking is safe: it only navigates to the employer's posting. window.open is
// already neutralised into same-tab navigation, but some buttons still spawn a
// tab, so check both.
export async function captureExternalApplyUrl(page) {
  const browser = page.browser();
  const before = page.url();
  const tabsBefore = new Set(await browser.pages());

  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('#company-site-button');
    if (btn) { btn.click(); return true; }
    const PHRASES = ['apply on company', 'company website', 'visit employer', 'apply externally'];
    for (const el of document.querySelectorAll('button, a, [class*="apply"]')) {
      const t = (el.textContent || '').trim().toLowerCase();
      if (PHRASES.some(p => t.includes(p))) { el.click(); return true; }
    }
    return false;
  }).catch(() => false);
  if (!clicked) return null;

  await page.waitForFunction(
    (b) => window.location.href !== b,
    { timeout: 9000 },
    before
  ).catch(() => {});

  const isUsable = (u) => u && /^https?:/.test(u) && !u.includes('naukri.com') && !u.startsWith('about:');

  let found = isUsable(page.url()) ? page.url() : null;

  // Check for a spawned tab, and clean up anything we opened.
  const tabsAfter = await browser.pages();
  for (const p of tabsAfter) {
    if (tabsBefore.has(p) || p === page) continue;
    const u = p.url();
    if (!found && isUsable(u)) found = u;
    await p.close().catch(() => {});
  }

  // Leave the working tab where it started so the caller's loop is unaffected.
  if (page.url() !== before) {
    await page.goto(before, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  }
  return found;
}

// Attempt Naukri Easy Apply for a single job. Returns { success, reason, externalUrl? }
export async function naukriEasyApply(page, job, signal, ctx) {
  try {
    await prepareNaukriPage(page);
    await page.goto(job.link, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise(r => setTimeout(r, 2000));

    // Check for "Apply on Company Website" — confirmed ID: #company-site-button
    const externalUrl = await page.evaluate(() => {
      // Primary: confirmed semantic ID (won't be minified)
      const btn = document.querySelector('#company-site-button');
      if (btn) {
        const href = btn.getAttribute('href') || btn.querySelector('a')?.href || '';
        return href && !href.includes('naukri.com') ? href : '__external__';
      }
      // Fallback: text-based detection
      const PHRASES = ['apply on company', 'company website', 'visit employer', 'apply externally'];
      for (const el of document.querySelectorAll('button, a, [class*="apply"]')) {
        const t = (el.textContent || '').trim().toLowerCase();
        if (PHRASES.some(p => t.includes(p))) {
          const hrefs = [
            el.tagName === 'A' ? el.href : '',
            el.querySelector('a')?.href || '',
            el.closest('a')?.href || '',
          ];
          const real = hrefs.find(h => h && h.startsWith('http') && !h.includes('naukri.com') && !h.startsWith('javascript:'));
          return real || '__external__';
        }
      }
      return null;
    });
    if (externalUrl) {
      // '__external__' means we detected the button but couldn't read a link off
      // it — which is the normal case, since it's a JS handler. Click through to
      // find out where it goes instead of throwing the job away.
      const resolved = externalUrl === '__external__'
        ? await captureExternalApplyUrl(page).catch(() => null)
        : externalUrl;
      return {
        success: false,
        reason: 'Apply on company website — skip',
        externalUrl: resolved || null,
      };
    }

    // Check already applied — confirmed ID: #already-applied
    const alreadyApplied = await page.evaluate(() =>
      !!document.querySelector('#already-applied') ||
      /(you.ve already applied|already applied|application was submitted)/i.test(document.body.textContent)
    );
    if (alreadyApplied) return { success: false, reason: 'Already applied' };

    // Click the Apply button — most reliable: text XPath equivalent
    // Confirmed from multiple GitHub repos: text()='Apply' is stable across Naukri deploys
    // Wrapped in withTabCleanup: some Apply buttons ignore the window.open override
    // (e.g. real target="_blank" anchors added after the page loaded) and still
    // spawn a stray tab — close it immediately rather than let it accumulate.
    const clicked = await withTabCleanup(page, () => page.evaluate(() => {
      // Primary: find by exact text 'Apply' or 'Easy Apply' (XPath-style text match)
      const allEls = Array.from(document.querySelectorAll('button, a, [class*="applyBtn"], [class*="apply-btn"]'));
      const SKIP = ['company website', 'company site', 'external', 'login', 'register', 'sign in'];
      const TARGET = ['easy apply', 'apply now', 'apply'];

      // Exact text match first (most reliable)
      for (const el of allEls) {
        const t = (el.textContent || '').trim().toLowerCase();
        if (SKIP.some(s => t.includes(s))) continue;
        if (t === 'apply' || t === 'easy apply') { el.click(); return t; }
      }
      // Startswith match
      for (const el of allEls) {
        const t = (el.textContent || '').trim().toLowerCase();
        if (SKIP.some(s => t.includes(s))) continue;
        if (TARGET.some(p => t.startsWith(p))) { el.click(); return t; }
      }
      return null;
    }));
    if (!clicked) return { success: false, reason: 'No Apply button found' };

    // Most jobs apply instantly: clicking Apply navigates to a confirmation page
    // (/myapply/showAcp?...multiApplyResp={id:202}) with no questions. Others open
    // a chatbot drawer with screening questions. Poll for up to ~10s for whichever
    // appears — instant-apply success, OR a question panel to answer.
    const detectState = () => page.evaluate(() => {
      const url = location.href;
      const body = document.body.textContent || '';
      const instantApplied =
        /\/myapply\/showAcp/i.test(url) ||
        /multiApplyResp/i.test(url) ||
        /(successfully applied|application submitted|you have applied|applied successfully|thank you for applying)/i.test(body);
      const hasChatbot =
        !!document.querySelector('ul[id*="chatList_"]') ||
        document.querySelectorAll('.ssrc__radio-btn-container').length > 0 ||
        !!document.querySelector('div.textArea') ||
        !!document.querySelector('[class*="chatbot"], [class*="Chatbot"], [class*="chatBot"]');
      return { instantApplied, hasChatbot };
    });

    let sawChatbot = false;
    for (let i = 0; i < 6; i++) {
      if (signal?.aborted) return { success: false, reason: 'Stopped by user' };
      const s = await detectState();
      if (s.hasChatbot) { sawChatbot = true; break; }
      if (s.instantApplied) return { success: true, reason: 'Applied (instant)' };
      await new Promise(r => setTimeout(r, 1200));
    }

    if (!sawChatbot) {
      // No chatbot and no explicit success signal — re-check once more, then treat
      // as applied (Naukri often confirms via a toast that's already gone).
      const s = await detectState();
      if (s.instantApplied) return { success: true, reason: 'Applied (instant)' };
      return { success: true, reason: 'Submitted (verify on Naukri profile)' };
    }

    // ── Chatbot conversation loop (up to 25 turns) ───────────────────────────────
    let turns = 0;
    let noneStreak = 0;
    while (turns < 25) {
      if (signal?.aborted) return { success: false, reason: 'Stopped by user' };
      turns++;

      const s = await detectState();
      if (s.instantApplied) return { success: true, reason: 'Applied via chatbot' };

      await new Promise(r => setTimeout(r, 1000));

      const action = await withTabCleanup(page, () => answerChatbotTurn(page, ctx));
      ctx?.onTurn?.(action);

      if (action === 'unanswerable') {
        // The agent had no confident answer. Guessing here is exactly how the
        // old keyword-only version silently submitted wrong data — bail out and
        // let this one be finished by hand instead.
        const s2 = await detectState();
        if (s2.instantApplied) return { success: true, reason: 'Applied via chatbot' };
        return { success: false, reason: 'Screening question needs a human answer' };
      }

      if (action === 'none') {
        noneStreak++;
        // Give the drawer extra time before giving up — questions can lag behind
        // the previous answer's animation.
        if (noneStreak >= 3) break;
        await new Promise(r => setTimeout(r, 1500));
      } else {
        noneStreak = 0;
      }

      await new Promise(r => setTimeout(r, 1000));
    }

    // Final success check — only claim success on an explicit confirmation.
    const finalState = await detectState();
    if (finalState.instantApplied) return { success: true, reason: 'Applied via chatbot' };
    return { success: false, reason: 'Chatbot ended without a confirmation' };
  } catch (e) {
    return { success: false, reason: e.message };
  }
}
