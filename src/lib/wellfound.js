// Wellfound (formerly AngelList Talent) auto-apply agent
// Three phases: India (any mode) → Remote outside India → Onsite outside India (with sponsorship)
// Apply flow: single-click → optional "Note" textarea → "Send Application" button

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Anti-detection setup for each page ───────────────────────────────────────
async function stealthPage(page) {
  await page.setUserAgent(USER_AGENT);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    window.chrome = { runtime: {} };
  });
}

// ── Pulkit's profile for form answers ────────────────────────────────────────
export const WF_PROFILE = {
  name:               'Pulkit Agarwal',
  email:              process.env.WELLFOUND_EMAIL || 'candidate@example.com',
  phone:              process.env.WELLFOUND_PHONE || '+910000000000',
  location:           process.env.WELLFOUND_LOCATION || 'Bengaluru, Karnataka, India',
  workExpYears:       2,
  techExpYears:       4,
  gender:             'Male',
  ethnicity:          'Asian',
  veteran:            false,
  requireSponsorship: true,
  authorizedUS:       false,
  linkedIn:           process.env.WELLFOUND_LINKEDIN || 'https://www.linkedin.com/in/your-profile',
  github:             process.env.WELLFOUND_GITHUB || 'https://github.com/your-username',
};

// ── Job search URL phases ─────────────────────────────────────────────────────
// Confirmed URL format: /role/l/{role}/{location} and /role/r/{role}
export const WF_SEARCH_PHASES = [
  {
    id: 'india',
    label: 'India (any work mode)',
    urls: [
      'https://wellfound.com/role/l/software-engineer/india',
      'https://wellfound.com/role/l/full-stack-engineer/india',
      'https://wellfound.com/role/l/backend-engineer/india',
      'https://wellfound.com/role/l/software-engineer/bangalore',
    ],
  },
  {
    id: 'remote-global',
    label: 'Remote (outside India)',
    urls: [
      'https://wellfound.com/role/r/software-engineer',
      'https://wellfound.com/role/r/backend-engineer',
      'https://wellfound.com/role/r/full-stack-engineer',
    ],
  },
  {
    id: 'onsite-global',
    label: 'Onsite outside India (sponsorship)',
    urls: [
      'https://wellfound.com/role/l/software-engineer/united-states',
      'https://wellfound.com/role/l/software-engineer/canada',
      'https://wellfound.com/role/l/software-engineer/united-kingdom',
      'https://wellfound.com/role/l/software-engineer/germany',
    ],
  },
];

// ── Login ─────────────────────────────────────────────────────────────────────
// Confirmed selectors: #user_email, #user_password, [name="commit"]
export async function wellfoundLogin(page, email, password) {
  await stealthPage(page);
  await page.goto('https://wellfound.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2500));

  // Wait out Cloudflare challenge if present
  const isCloudflare = await page.evaluate(() =>
    document.title.includes('Just a moment') || document.title.includes('Attention Required')
  );
  if (isCloudflare) {
    await new Promise(r => setTimeout(r, 15000));
  }

  // Fill email — confirmed selector: #user_email
  const emailOk = await page.evaluate((e) => {
    const el = document.querySelector('#user_email') ||
               document.querySelector('input[name="user[email]"]') ||
               document.querySelector('input[type="email"]');
    if (!el) return false;
    const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (desc?.set) desc.set.call(el, e); else el.value = e;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, email);
  if (!emailOk) throw new Error('Wellfound login: #user_email field not found');

  await new Promise(r => setTimeout(r, 500));

  // Fill password — confirmed selector: #user_password
  const passOk = await page.evaluate((p) => {
    const el = document.querySelector('#user_password') ||
               document.querySelector('input[name="user[password]"]') ||
               document.querySelector('input[type="password"]');
    if (!el) return false;
    const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (desc?.set) desc.set.call(el, p); else el.value = p;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, password);
  if (!passOk) throw new Error('Wellfound login: #user_password field not found');

  await new Promise(r => setTimeout(r, 500));

  // Submit — confirmed selector: [name="commit"]
  await page.evaluate(() => {
    const btn = document.querySelector('[name="commit"]') ||
                document.querySelector('button[type="submit"]') ||
                document.querySelector('input[type="submit"]');
    if (btn) btn.click();
  });

  // Wait for URL to leave /login (up to 20s)
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (!page.url().includes('/login')) return;
  }
  throw new Error('Wellfound login failed — still on /login after 20s. Solve CAPTCHA in browser first.');
}

// ── Scrape job listings from a /role/ page ────────────────────────────────────
export async function scrapeWellfoundJobCards(page, url) {
  await stealthPage(page);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  // Check for Cloudflare block
  const blocked = await page.evaluate(() =>
    document.title.includes('Just a moment') || document.title.includes('Access denied')
  );
  if (blocked) return [];

  // Scroll to trigger lazy-loaded job cards
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollBy(0, 700));
    await new Promise(r => setTimeout(r, 700));
  }

  return page.evaluate(() => {
    const jobs = [];
    const seen = new Set();

    // Primary: find all job apply links — /jobs/{company}?jobId={id} pattern
    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const jobAnchors = anchors.filter(a => {
      const href = a.href || '';
      return (href.includes('/jobs/') || href.includes('jobId=')) &&
             !href.includes('/company') && !href.includes('/startup');
    });

    for (const a of jobAnchors) {
      const url = a.href;
      const baseKey = url.split('?')[0];
      if (seen.has(baseKey)) continue;
      seen.add(baseKey);

      const card = a.closest('[class*="Startup"], [class*="startup"], [class*="Job"], [class*="job"], article, li') || a.parentElement;
      const titleEl = card?.querySelector('h2, h3, h4, [class*="title"], [class*="role"], [class*="name"]');
      const companyEl = card?.querySelector('[class*="company"], [class*="startup-name"], [class*="CompanyName"]');
      const descEl = card?.querySelector('p, [class*="description"], [class*="desc"]');
      const locEl  = card?.querySelector('[class*="location"], [class*="loc"]');

      const text = (titleEl?.textContent || a.textContent || '').trim();
      if (!text || text.length < 2) continue;

      jobs.push({
        title:       text,
        company:     (companyEl?.textContent || '').trim(),
        location:    (locEl?.textContent     || '').trim(),
        description: (descEl?.textContent    || '').trim().slice(0, 600),
        applyUrl:    url,
        cardUrl:     url,
      });
    }

    // Fallback: broad card selector scan
    if (jobs.length === 0) {
      const cardSelectors = [
        '[data-test="StartupResult"]', '[class*="JobListing"]', '[class*="job-listing"]',
        '[class*="StartupCard"]', '[class*="styles_result"]', '.results-list > div',
      ];
      for (const sel of cardSelectors) {
        const cards = Array.from(document.querySelectorAll(sel));
        if (!cards.length) continue;
        for (const card of cards.slice(0, 60)) {
          const link = card.querySelector('a[href*="/jobs/"], a[href*="jobId"]') || card.querySelector('a');
          if (!link?.href) continue;
          const key = link.href.split('?')[0];
          if (seen.has(key)) continue;
          seen.add(key);
          const titleEl = card.querySelector('h2, h3, h4, [class*="title"], [class*="role"]');
          const companyEl = card.querySelector('[class*="company"], [class*="startup"], h4');
          const descEl = card.querySelector('p, [class*="desc"]');
          jobs.push({
            title:       (titleEl?.textContent || link.textContent || '').trim(),
            company:     (companyEl?.textContent || '').trim(),
            location:    '',
            description: (descEl?.textContent   || '').trim().slice(0, 600),
            applyUrl:    link.href,
            cardUrl:     link.href,
          });
        }
        if (jobs.length > 0) break;
      }
    }

    return jobs.filter(j => j.title && j.title.length > 2);
  });
}

// ── Generate AI cover letter ──────────────────────────────────────────────────
export async function generateCoverLetter(job) {
  const prompt = `Write a short Wellfound application "Note" (100-140 words, direct and enthusiastic).

Job: ${job.title} at ${job.company || 'a startup'}
Description hint: ${(job.description || 'Software engineering role').slice(0, 300)}

About me (Pulkit Agarwal):
- Full-Stack Developer, 2 years professional / 4 years in tech
- Currently at Magna International: GoLang microservices, OIDC/RBAC, Docker, Kubernetes
- Also built: React.js/Next.js/Vue.js apps, Node.js/Express APIs, MongoDB/Redis, AI integrations
- BTech CSE, CGPA 8.96, based in Bengaluru

Write in first person. Be specific to the role/company. No greeting/header. Start directly with content. Max 140 words.`;

  try {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
          signal: AbortSignal.timeout(12000),
        }
      );
      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text) return text;
      }
    }
  } catch {}

  try {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 200,
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content?.trim();
        if (text) return text;
      }
    }
  } catch {}

  return `Excited to apply for ${job.title} at ${job.company || 'your company'}. I'm a Full-Stack Developer with 2 years of professional experience and 4 years in tech. At Magna International I built GoLang microservices, OIDC/RBAC auth systems, and Docker/K8s deployments for enterprise clients. Previously at Cadera Infotech I built full-stack SaaS platforms using React.js, Next.js, Node.js, and MongoDB, including AI-powered workflows. I love owning features end-to-end and move fast without sacrificing quality. Would be a great fit for your team.`;
}

// ── Apply to a single Wellfound job ──────────────────────────────────────────
// Wellfound apply: click Apply → fill "Note" textarea → click "Send Application"
export async function applyToWellfoundJob(page, job, onProgress) {
  try {
    if (!job.applyUrl) return { success: false, reason: 'No apply URL' };

    await stealthPage(page);
    await page.goto(job.applyUrl, { waitUntil: 'networkidle2', timeout: 25000 });
    await new Promise(r => setTimeout(r, 2500));

    // Check Cloudflare block
    const blocked = await page.evaluate(() =>
      document.title.includes('Just a moment') || document.title.includes('Access denied')
    );
    if (blocked) return { success: false, reason: 'Cloudflare block — use existing Chrome session' };

    // Check already applied
    const alreadyApplied = await page.evaluate(() =>
      /already applied|you applied|application submitted/i.test(document.body.textContent) ||
      !!document.querySelector('[data-test="AppliedBadge"], [class*="applied-badge"]')
    );
    if (alreadyApplied) return { success: false, reason: 'Already applied' };

    // Click the Apply button
    await page.evaluate(() => {
      const SKIP   = ['save', 'bookmark', 'share', 'similar', 'follow'];
      const TARGET = ['apply', 'easy apply', 'apply now', 'apply for this role', 'apply to role'];
      const els = Array.from(document.querySelectorAll('button, a'));
      for (const el of els) {
        const t = (el.textContent || '').trim().toLowerCase();
        if (SKIP.some(s => t === s || t.includes(s))) continue;
        if (TARGET.some(p => t === p || t.startsWith(p))) {
          el.click();
          return;
        }
      }
    });
    await new Promise(r => setTimeout(r, 2000));

    // Generate cover letter
    const coverLetter = await generateCoverLetter(job);

    // Fill "Note" textarea — Wellfound's single apply field
    const noteFilled = await page.evaluate((cl) => {
      const selectors = [
        'textarea[placeholder*="note" i]',
        'textarea[placeholder*="cover" i]',
        'textarea[placeholder*="introduce" i]',
        'textarea[placeholder*="tell" i]',
        'textarea[placeholder*="why" i]',
        'textarea[aria-label*="note" i]',
        'textarea[name*="note"]',
        'textarea[name*="cover"]',
        'textarea',
      ];
      for (const sel of selectors) {
        const ta = document.querySelector(sel);
        if (ta && ta.offsetParent !== null) {
          const desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
          if (desc?.set) desc.set.call(ta, cl); else ta.value = cl;
          ta.dispatchEvent(new Event('input',  { bubbles: true }));
          ta.dispatchEvent(new Event('change', { bubbles: true }));
          ta.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
          return true;
        }
      }
      return false;
    }, coverLetter);

    if (noteFilled) onProgress?.(`  ✍ Cover letter filled`);
    await new Promise(r => setTimeout(r, 800));

    // Click "Send Application" — confirmed submit text per research
    const submitted = await page.evaluate(() => {
      const SUBMIT = ['send application', 'submit application', 'submit', 'send', 'apply'];
      const SKIP   = ['cancel', 'close', 'back', 'save', 'dismiss'];
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
      for (const btn of btns) {
        const t = (btn.textContent || btn.value || '').trim().toLowerCase();
        if (SKIP.some(s => t.includes(s))) continue;
        if (SUBMIT.some(s => t === s || t.includes(s))) {
          if (!btn.disabled) { btn.click(); return t; }
        }
      }
      return null;
    });

    if (!submitted) return { success: false, reason: 'Submit button not found' };

    await new Promise(r => setTimeout(r, 2500));

    // Verify success
    const success = await page.evaluate(() =>
      /application submitted|applied successfully|thank you|we.ve received|successfully sent/i.test(document.body.textContent) ||
      !!document.querySelector('[data-test="AppliedBadge"], [class*="applied-badge"], [class*="success"]')
    );

    return {
      success: true,
      reason: success ? 'Application submitted' : 'Submitted (verify on Wellfound)',
      coverLetter,
    };
  } catch (e) {
    return { success: false, reason: (e.message || 'Unknown error').slice(0, 120) };
  }
}
