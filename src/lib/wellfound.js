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

// ── One-time profile setup ────────────────────────────────────────────────────
// Wellfound's native apply is profile-driven: clicking "Apply" sends your existing
// Jobs Profile + resume to the employer. There is NO LinkedIn/GitHub/work-authorization
// field in the per-job apply modal — those live at wellfound.com/profile/edit and
// wellfound.com/profile/edit/preferences (confirmed via Wellfound's own help docs).
// Run this ONCE per session before applying to any jobs.
export async function setupWellfoundProfile(page, onProgress) {
  const results = { social: false, preferences: false };

  // ── Social links (LinkedIn / GitHub / portfolio) ────────────────────────────
  try {
    await stealthPage(page);
    await page.goto('https://wellfound.com/profile/edit', { waitUntil: 'networkidle2', timeout: 25000 });
    await new Promise(r => setTimeout(r, 2500));

    const filled = await page.evaluate((profile) => {
      function setReactVal(el, val) {
        const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (desc?.set) desc.set.call(el, val); else el.value = val;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      function labelOf(el) {
        if (el.id) {
          const lbl = document.querySelector(`label[for="${el.id}"]`);
          if (lbl) return lbl.textContent.toLowerCase();
        }
        const container = el.closest('[class*="field"], [class*="row"], [class*="input"], label, div');
        return (container?.textContent || el.placeholder || el.name || '').toLowerCase();
      }

      let count = 0;
      document.querySelectorAll('input[type="text"], input[type="url"], input:not([type])').forEach(el => {
        if (el.disabled || el.readOnly || !el.offsetParent) return;
        const label = labelOf(el);
        const existing = (el.value || '').trim();

        if (/linkedin/i.test(label) && !/linkedin\.com/i.test(existing)) {
          setReactVal(el, profile.linkedIn); count++;
        } else if (/github/i.test(label) && !/github\.com/i.test(existing)) {
          setReactVal(el, profile.github); count++;
        } else if (/portfolio|personal (site|website)|your website/i.test(label) && !existing) {
          setReactVal(el, profile.github); count++; // reuse GitHub as portfolio fallback
        }
      });
      return count;
    }, WF_PROFILE);

    if (filled > 0) {
      // Try to save/submit the profile form
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b =>
          /^(save|save changes|update profile|save profile)$/i.test((b.textContent || '').trim())
        );
        if (btn && !btn.disabled) btn.click();
      });
      await new Promise(r => setTimeout(r, 1500));
      onProgress?.(`  ✓ Profile: filled ${filled} social link field(s)`);
      results.social = true;
    } else {
      onProgress?.('  ○ Profile: social links already set or fields not found');
    }
  } catch (e) {
    onProgress?.(`  ⚠ Profile social-link setup skipped: ${(e.message || '').slice(0, 100)}`);
  }

  // ── Preferences (work authorization, sponsorship, salary, remote pref) ──────
  try {
    await page.goto('https://wellfound.com/profile/edit/preferences', { waitUntil: 'networkidle2', timeout: 25000 });
    await new Promise(r => setTimeout(r, 2000));

    const changed = await page.evaluate((profile) => {
      let count = 0;

      function labelOf(el) {
        if (el.id) {
          const lbl = document.querySelector(`label[for="${el.id}"]`);
          if (lbl) return lbl.textContent.toLowerCase();
        }
        const container = el.closest('[class*="field"], [class*="row"], [class*="section"], label, div');
        return (container?.textContent || '').toLowerCase();
      }

      // Radio/checkbox groups for work authorization + sponsorship
      document.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach(el => {
        if (!el.offsetParent) return;
        const combined = labelOf(el).toLowerCase();

        if (/authoriz.*(work|us|usa)|work.*authoriz/i.test(combined)) {
          const wantsYes = profile.location.includes('India'); // authorized in India, not in US
          if (/india|yes/i.test(combined) === wantsYes && !el.checked) { el.click(); count++; }
        } else if (/sponsor|visa/i.test(combined)) {
          if (/yes|need|require/i.test(combined) && !el.checked) { el.click(); count++; }
        }
      });

      // Select dropdowns for salary / experience range if present
      document.querySelectorAll('select').forEach(sel => {
        if (!sel.offsetParent) return;
        const label = labelOf(sel);
        if (/years.*exp|experience/i.test(label)) {
          const opts = Array.from(sel.options);
          const match = opts.find(o => /\b1.?2\b|\b2\b/i.test(o.text));
          if (match) { sel.value = match.value; sel.dispatchEvent(new Event('change', { bubbles: true })); count++; }
        }
      });

      return count;
    }, WF_PROFILE);

    if (changed > 0) {
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b =>
          /^(save|save changes|update preferences)$/i.test((b.textContent || '').trim())
        );
        if (btn && !btn.disabled) btn.click();
      });
      await new Promise(r => setTimeout(r, 1500));
      onProgress?.(`  ✓ Profile: updated ${changed} preference field(s)`);
      results.preferences = true;
    } else {
      onProgress?.('  ○ Profile: preferences already set or fields not found');
    }
  } catch (e) {
    onProgress?.(`  ⚠ Profile preferences setup skipped: ${(e.message || '').slice(0, 100)}`);
  }

  return results;
}

// ── GraphQL-based apply (primary path) ────────────────────────────────────────
// Reverse-engineered from working OSS bots (apoorvdarshan/wellfound-bot,
// Nirvanjha2004/wellfound-auto-apply-bot). Runs entirely inside the page context
// via window.fetch so it inherits real cookies + browser fingerprint (avoids
// DataDome bot-detection that a Node-side HTTP client would trigger).
// Falls back to DOM clicking automatically if the persisted-query hash is stale.
const GQL_OPERATION_ID = 'tfe/b8b8f259334b9998f1034458d18eeda958decc17a57da9280a9fd121aa522015';

async function extractJobListingId(page) {
  return page.evaluate(() => {
    const url = new URL(window.location.href);
    const qsId = url.searchParams.get('jobId');
    if (qsId) return qsId;
    const match = window.location.pathname.match(/jobs\/(\d+)/);
    return match ? match[1] : null;
  });
}

async function fetchJobApplicationModal(page, jobListingId) {
  return page.evaluate(async (jobListingId) => {
    try {
      const res = await fetch('/graphql?fallbackAOR=talent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Apollographql-Client-Name': 'talent-web',
        },
        credentials: 'include',
        body: JSON.stringify({
          operationName: 'JobApplicationModal',
          variables: { jobListingId },
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.data || null;
    } catch {
      return null;
    }
  }, jobListingId);
}

async function submitGraphQLApplication(page, { jobListingId, startupId, userNote, customQuestionAnswers }) {
  return page.evaluate(async ({ jobListingId, startupId, userNote, customQuestionAnswers, operationId }) => {
    const payload = {
      operationName: 'CreateJobApplication',
      variables: {
        input: {
          sourceId: null,
          jobListingId,
          product: 'job search',
          questionResponseSets: null,
          customQuestionAnswers: customQuestionAnswers || [],
          startupId,
          userNote: userNote || '',
        },
      },
      extensions: { persistedQuery: { version: 1, sha256Hash: operationId.split('/')[1] } },
    };

    async function post(body) {
      const res = await fetch('/graphql?fallbackAOR=talent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Apollographql-Client-Name': 'talent-web' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      return { ok: res.ok, json: await res.json().catch(() => null) };
    }

    const first = await post(payload);
    if (first.json?.errors?.some(e => /PersistedQueryNotFound/i.test(e.message || ''))) {
      return { ok: false, staleHash: true };
    }
    if (first.json?.data?.createJobApplication || first.ok) {
      return { ok: true, data: first.json?.data };
    }
    return { ok: false, errors: first.json?.errors };
  }, { jobListingId, startupId, userNote, customQuestionAnswers, operationId: GQL_OPERATION_ID });
}

// Answer a single custom screening question using AI or profile heuristics
async function answerCustomQuestion(question, job) {
  const text = (question.question || '').toLowerCase();
  const options = question.options || question.jobListingQuestionOptions || [];

  // Structured question with predefined options — pick the best match, don't call AI
  if (options.length > 0) {
    let picked = null;
    if (/notice|joining/i.test(text)) picked = options.find(o => /15|immed/i.test(o.text || o.label || ''));
    else if (/sponsor|visa/i.test(text)) picked = options.find(o => /yes/i.test(o.text || o.label || ''));
    else if (/authoriz.*(work|us)/i.test(text)) picked = options.find(o => /no/i.test(o.text || o.label || ''));
    else if (/years?.*exp|experience/i.test(text)) picked = options.find(o => /1.?2|2.?4|\b2\b/i.test(o.text || o.label || ''));
    else if (/salary|compensation/i.test(text)) picked = options.find(o => /\b14|12.?16|10.?15/i.test(o.text || o.label || ''));
    picked = picked || options[0];
    return {
      answer: picked.text || picked.label || '',
      jobListingQuestionOptionId: picked.id || picked.value || null,
    };
  }

  // Free-text question — use AI cover-letter generator with the question as context
  const answer = await generateCoverLetter(job, question.question);
  return { answer, jobListingQuestionOptionId: null };
}

async function tryGraphQLApply(page, job, onProgress) {
  const jobListingId = await extractJobListingId(page);
  if (!jobListingId) return { attempted: false };

  const modalData = await fetchJobApplicationModal(page, jobListingId);
  if (!modalData) return { attempted: false };

  const jobListing = modalData.jobListing || modalData.talent?.jobListing || null;
  if (!jobListing) return { attempted: false };

  if (jobListing.currentUserApplied) {
    return { attempted: true, success: false, reason: 'Already applied' };
  }
  // External ATS jobs can't use the native apply mutation
  const externalUrl = jobListing.externalApplicationUrl || jobListing.applicationUrl || jobListing.applyUrl || null;
  if (jobListing.atsSource || externalUrl) {
    return { attempted: true, success: false, reason: 'Apply on company website — skip', externalUrl };
  }

  const startupId = jobListing.startupId || modalData.startupId;
  const questions = jobListing.screeningQuestions || jobListing.questions || [];

  onProgress?.(`  🧾 GraphQL: ${questions.length} screening question(s) detected`);

  const customQuestionAnswers = [];
  for (const q of questions) {
    const { answer, jobListingQuestionOptionId } = await answerCustomQuestion(q, job);
    customQuestionAnswers.push({
      jobListingQuestionId: q.id,
      answer,
      jobListingQuestionOptionId,
    });
    onProgress?.(`  ✍ Answered: ${(q.question || '').slice(0, 60)}`);
  }

  const userNote = await generateCoverLetter(job, 'Cover letter / note to the company');

  const result = await submitGraphQLApplication(page, {
    jobListingId,
    startupId,
    userNote,
    customQuestionAnswers,
  });

  if (result.staleHash) {
    onProgress?.('  ⚠ GraphQL persisted-query hash stale — falling back to DOM click flow');
    return { attempted: false };
  }
  if (result.ok) {
    return { attempted: true, success: true, reason: 'Applied via GraphQL', coverLetter: userNote };
  }
  return { attempted: true, success: false, reason: 'GraphQL apply failed — falling back to DOM flow', fallback: true };
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
// Rotate opening styles so applications don't all read like the same template
// when an employer or reviewer compares notes across candidates/companies.
const OPENER_STYLES = [
  'Start by naming one specific thing from the job description or company description that genuinely stands out — a product detail, a technical challenge, or a stated mission — before connecting it to yourself.',
  'Start with a concrete observation about the problem this role is solving, drawn from the job description, then pivot to why that specific problem excites you.',
  'Start by referencing the stage/scale of the company (if mentioned) or the specific tech stack in the listing, then explain why that context is a good fit for how you like to work.',
  'Open with what the team appears to be building or solving (paraphrased from the description, not generic), then explain the overlap with your own experience.',
];

// Deterministic string hash — lets different job+question pairs land on different
// opener styles without needing Math.random() (which the workflow runtime disallows
// and which would also make cache/resume behavior non-reproducible).
function hashSeed(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) | 0;
  }
  return h;
}

export async function generateCoverLetter(job, questionPrompt = '', variantSeed = null) {
  const seed = variantSeed ?? hashSeed(`${job.company || ''}:${job.title || ''}:${questionPrompt || ''}`);
  const normalizedQuestion = questionPrompt || 'Cover letter';
  const isCompanyFocusedQuestion = /what interests you about working for this company|why (do you want to work|this company)|why us|why are you interested in (this|our) company|interests you about (the|this) company/i
    .test(normalizedQuestion);
  const responseGoal = isCompanyFocusedQuestion
    ? 'Make the answer primarily about THE COMPANY: what it builds, the problem space, its stage/mission, or its engineering culture — pulled from the job description text, not invented. Mention your fit for the role only in the last 1-2 sentences.'
    : 'Make the answer primarily about your fit for the ROLE, using specific details from the job description to justify it — not generic enthusiasm.';
  const opener = OPENER_STYLES[Math.abs(seed) % OPENER_STYLES.length];

  const prompt = `Write a tailored Wellfound application response in first person.

Application field/question: ${normalizedQuestion}
Job title: ${job.title}
Company: ${job.company || 'a startup'}
Job description (use concrete details from this — do not write generically):
${(job.description || 'Software engineering role').slice(0, 2500)}

Candidate profile:
- Pulkit Agarwal, backend-leaning software engineer, Bengaluru based
- 2 years professional experience, 4 years total hands-on building
- Magna International: designed and shipped Go microservices, auth/identity flows with OIDC/RBAC, production deployments on Docker and Kubernetes
- Also built backend services, APIs, async flows, caching, and full-stack features with Node.js, Express, React, Next.js, MongoDB, Redis, and AI-powered workflows
- Comfortable owning a feature or service end to end, from design through deployment

Style requirement for the OPENING SENTENCE (do not skip this): ${opener}

Other requirements:
- Reference at least one CONCRETE detail pulled from the job description above (a technology, a product name, a specific responsibility, a stated problem, team size, or mission line) — do not write something that could apply to any company
- ${responseGoal}
- Do not start with "What interests me most" or "What stands out to me" — vary the phrasing per the opener style above
- Keep it concise: 100-150 words
- No greeting, no sign-off, no "Dear Hiring Manager"
- Where relevant, connect your own experience (microservices, APIs, auth, reliability, ownership) back to something specific mentioned in the job description — don't just list your skills in isolation
- Do not mention CGPA, BTech, grades, or academics unless the job description explicitly requires it
- Sound like a specific, thoughtful human wrote this for THIS job — not a reusable template`;

  try {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.85, topP: 0.9 },
          }),
          signal: AbortSignal.timeout(15000),
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
          max_tokens: 260,
          temperature: 0.85,
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content?.trim();
        if (text) return text;
      }
    }
  } catch {}

  // Non-AI fallback — still pulls in whatever concrete description text we have
  // instead of a fully generic template, so it degrades gracefully rather than
  // reading as an obvious form letter if both AI providers are unavailable.
  const descSnippet = (job.description || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const roleContext = descSnippet ? ` Specifically, the focus on "${descSnippet}..." lines up well with how I like to work.` : '';

  if (isCompanyFocusedQuestion) {
    return `${job.company || 'This company'}'s work on ${job.title || 'this role'} is what caught my attention — I like teams that are building something with a clear technical problem at the center rather than just adding features.${roleContext} I'm drawn to environments where engineers can own a service end to end: design, build, deploy, and iterate. That's the kind of ownership I've had at Magna International, building Go microservices and OIDC/RBAC-based auth systems deployed on Docker and Kubernetes, and it's the kind of environment I want more of.`;
  }

  return `I'd be a strong fit for the ${job.title || 'role'} at ${job.company || 'your team'} because my background lines up directly with what the role needs.${roleContext} At Magna International I designed and shipped Go microservices and OIDC/RBAC-based authentication, running on Docker and Kubernetes in production. Before that I built full-stack systems end to end — APIs, async flows, caching layers, and AI-powered workflows — with Node.js, Express, React, and MongoDB. I like owning a problem from design through deployment rather than working on isolated pieces, and this role looks like exactly that kind of ownership.`;
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

    // ── Try GraphQL apply first — reads the job's actual screening questions
    // (with options/type) and answers each one, instead of guessing from DOM text.
    // Falls through to the DOM click-flow below if the persisted-query hash is stale
    // or the response shape doesn't match (Wellfound may rotate the API silently).
    const gqlResult = await tryGraphQLApply(page, job, onProgress);
    if (gqlResult.attempted && !gqlResult.fallback) {
      return gqlResult;
    }

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
