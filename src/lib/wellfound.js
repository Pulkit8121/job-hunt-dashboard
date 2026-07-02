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

async function extractWellfoundApplyContext(page, fallbackJob = {}) {
  return page.evaluate((fallback) => {
    const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();

    const company = clean(
      document.querySelector('[class*="company"], [class*="startup"], [data-test*="company"], h2, h3')?.textContent
    ) || fallback.company || '';

    const title = clean(
      document.querySelector('h1, [class*="title"], [class*="role"], [data-test*="title"]')?.textContent
    ) || fallback.title || '';

    const descCandidates = Array.from(document.querySelectorAll('section, article, div, p, li'))
      .map(el => clean(el.textContent))
      .filter(text =>
        text.length > 120 &&
        /responsibil|requirement|qualif|about the role|about us|what you.ll do|you will|experience/i.test(text)
      )
      .sort((a, b) => b.length - a.length);

    const description = (descCandidates[0] || fallback.description || '').slice(0, 3500);

    const textareas = Array.from(document.querySelectorAll('textarea'))
      .filter(el => el.offsetParent !== null)
      .map((textarea, index) => {
        let question = '';
        if (textarea.id) {
          question = clean(document.querySelector(`label[for="${textarea.id}"]`)?.textContent);
        }
        if (!question) {
          question = clean(textarea.getAttribute('aria-label'));
        }
        if (!question) {
          question = clean(textarea.getAttribute('placeholder'));
        }
        if (!question) {
          const container = textarea.closest('form, [class*="field"], [class*="question"], [class*="input"], [class*="application"]');
          question = clean(
            container?.querySelector('label, h1, h2, h3, h4, p, span, strong')?.textContent
          );
        }

        return {
          index,
          question: question || `Written response ${index + 1}`,
        };
      });

    return {
      title,
      company,
      description,
      question: textareas[0]?.question || '',
      textareas,
    };
  }, fallbackJob);
}

// ── Generate AI cover letter ──────────────────────────────────────────────────
export async function generateCoverLetter(job, questionPrompt = '') {
  const normalizedQuestion = questionPrompt || 'Cover letter';
  const isCompanyFocusedQuestion = /what interests you about working for this company|why (do you want to work|this company)|why us|why are you interested in (this|our) company|interests you about (the|this) company/i
    .test(normalizedQuestion);
  const responseGoal = isCompanyFocusedQuestion
    ? 'Make the answer primarily about the company: its mission, product, stage, team, engineering culture, or problem space based on the job description and page context. Mention the role only secondarily.'
    : 'Make the answer primarily about fit for the role, using the company and job description to stay specific.';
  const prompt = `Write a tailored Wellfound application response in first person.

Application field/question: ${normalizedQuestion}
Job title: ${job.title}
Company: ${job.company || 'a startup'}
Job description:
${(job.description || 'Software engineering role').slice(0, 2200)}

Candidate profile:
- Pulkit Agarwal
- Backend-leaning software engineer focused on systems and product delivery
- 2 years professional experience, 4 years total hands-on building
- Magna International: designed and shipped Go microservices, auth/identity flows with OIDC/RBAC, and production deployments using Docker and Kubernetes
- Built backend services, APIs, async flows, caching, and full-stack features with Node.js, Express, React, Next.js, MongoDB, Redis, and AI-powered workflows
- Bengaluru based

Requirements:
- Be specific to the company and role using the provided job description
- Answer the actual application field/question, especially if it asks "What interests you about working for this company?"
- ${responseGoal}
- Keep it concise: 90-140 words
- No greeting or sign-off
- Emphasize architecture, system design, microservices, APIs, reliability, scalability, and ownership where relevant
- Do not mention CGPA, BTech, grades, or academics unless the job description explicitly requires it
- Sound human, direct, and thoughtful`;

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

  if (isCompanyFocusedQuestion) {
    return `What interests me most about ${job.company || 'your company'} is the opportunity to work close to the product and the core problems the team is solving, rather than being far from impact. I’m drawn to companies where engineering quality matters because it directly shapes the user experience and the pace of the business. From the role, it seems the team values thoughtful backend design, scalable systems, and engineers who can own problems end to end. That combination is especially appealing to me because my strongest work has been around building microservices, shaping APIs, and improving reliability and architecture while still staying practical and product-focused.`;
  }

  return `What stands out to me about ${job.company || 'your company'} is the chance to work on meaningful engineering problems with real product impact. The role feels close to the work I enjoy most: designing backend services, building microservice-driven systems, shaping clean APIs, and thinking through reliability and scale instead of only implementing isolated features. In my current work I’ve built Go microservices, worked on OIDC/RBAC-based architecture, and shipped containerized services on Docker and Kubernetes, so I’d bring both hands-on execution and a strong systems mindset. I’m especially drawn to teams where engineers can own architecture decisions, move quickly, and help improve the product end to end.`;
}

async function fillWellfoundWrittenQuestions(page, enrichedJob, onProgress) {
  const fields = enrichedJob.textareas?.length
    ? enrichedJob.textareas
    : [{ index: 0, question: enrichedJob.question || 'Cover letter' }];

  const responses = [];

  for (const field of fields) {
    const question = field.question || `Written response ${field.index + 1}`;
    const response = await generateCoverLetter(enrichedJob, question);

    const filled = await page.evaluate(({ index, text }) => {
      const visibleTextareas = Array.from(document.querySelectorAll('textarea'))
        .filter(el => el.offsetParent !== null);
      const ta = visibleTextareas[index];
      if (!ta) return false;

      const desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
      if (desc?.set) desc.set.call(ta, text); else ta.value = text;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
      return true;
    }, { index: field.index, text: response });

    if (filled) {
      responses.push({ question, response });
      onProgress?.(`  ✍ Filled: ${question.slice(0, 70)}`);
      await new Promise(r => setTimeout(r, 500));
    }
  }

  return responses;
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

    const enrichedJob = {
      ...job,
      ...(await extractWellfoundApplyContext(page, job)),
    };
    onProgress?.(`  🧠 Tailoring response for ${enrichedJob.company || job.company || 'company'}`);
    const responses = await fillWellfoundWrittenQuestions(page, enrichedJob, onProgress);
    if (!responses.length) return { success: false, reason: 'Written response field not found' };
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
      coverLetter: responses[0]?.response || '',
    };
  } catch (e) {
    return { success: false, reason: (e.message || 'Unknown error').slice(0, 120) };
  }
}
