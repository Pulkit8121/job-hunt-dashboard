import { filterEligibleJobs, isRelevantJob } from './matcher.js';
import { analyzeJob } from './ai.js';
import { buildNaukriRoleSearchUrl, buildNaukriSearchUrl, SCRAPE_ROLE_SEARCHES } from './company-utils.js';
import { extractNaukriCards, openNaukriPage, resolveNaukriJobDetail } from './naukri.js';

// Source priority for display sorting — lower = shown first
export const SOURCE_PRIORITY = {
  'careers-page': 0,
  'career-agent': 0,
  'greenhouse':   0,
  'lever':        0,
  'wellfound':    2,
  'naukri':       3,
};

export function sortJobsBySource(jobs) {
  return [...jobs].sort((a, b) => {
    const pa = SOURCE_PRIORITY[a.source] ?? 1;
    const pb = SOURCE_PRIORITY[b.source] ?? 1;
    if (pa !== pb) return pa - pb;
    return (b.matchScore || 0) - (a.matchScore || 0);
  });
}

// ── Greenhouse public JSON API (no browser needed) ──────────────────────────
async function scrapeGreenhouse(slug) {
  try {
    const res = await fetch(
      `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
      { signal: AbortSignal.timeout(15000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.jobs || [])
      .filter(j => isRelevantJob(j.title))
      .slice(0, 80)
      .map(j => ({
        title: j.title,
        jobId: String(j.id),
        link: j.absolute_url,
        location: j.location?.name || 'India',
        description: stripHtml(j.content || '').slice(0, 600),
        source: 'careers-page',
        postedDate: (j.updated_at || '').split('T')[0] || today(),
      }));
  } catch {
    return [];
  }
}

// ── Lever public JSON API (no browser needed) ────────────────────────────────
async function scrapeLever(slug) {
  try {
    const res = await fetch(
      `https://api.lever.co/v0/postings/${slug}?mode=json`,
      { signal: AbortSignal.timeout(15000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data) ? data : [])
      .filter(j => isRelevantJob(j.text))
      .slice(0, 80)
      .map(j => ({
        title: j.text,
        jobId: j.id,
        link: j.hostedUrl,
        location: j.categories?.location || j.categories?.team || 'India',
        description: stripHtml(j.descriptionPlain || j.description || '').slice(0, 600),
        source: 'careers-page',
        postedDate: j.createdAt ? new Date(j.createdAt).toISOString().split('T')[0] : today(),
      }));
  } catch {
    return [];
  }
}

// ── Naukri scraper via Puppeteer ─────────────────────────────────────────────
function locationToCitySlug(location = '') {
  return location.toLowerCase().replace(/\s+/g, '-');
}

async function scrapeNaukri(company, browser, onProgress) {
  const citySlug = locationToCitySlug(company.locations?.[0] || 'bengaluru');
  const searchPlans = [
    {
      url: company.naukriSearchUrl || buildNaukriSearchUrl(company.name),
      label: 'company jobs',
    },
    ...SCRAPE_ROLE_SEARCHES.map(role => ({
      url: buildNaukriRoleSearchUrl(role.slug, citySlug, company.name),
      label: role.label,
    })),
  ];

  const page = await browser.newPage();
  const deduped = new Map();

  try {
    for (const plan of searchPlans) {
      if (!plan.url) continue;
      try {
        await openNaukriPage(page, plan.url);
        const cards = await extractNaukriCards(page);

        for (const card of cards) {
          if (!card.title || !card.link) continue;
          const jobKey = card.link || `${card.title}:${card.location}`;
          if (deduped.has(jobKey)) continue;

          deduped.set(jobKey, {
            title: card.title,
            jobId: card.jobId || String(Date.now() + Math.random()),
            link: card.link,
            location: card.location,
            description: card.description,
            experienceText: card.experienceText || '',
            source: 'naukri',
            isEasyApply: false,
            postedDate: today(),
          });
        }

        if (deduped.size >= 12) break;
      } catch (e) {
        onProgress(`⚠ Naukri ${plan.label} search failed for ${company.name}: ${e.message}`);
      }
    }
  } finally {
    await page.close();
  }

  const rawJobs = Array.from(deduped.values()).slice(0, 15);
  if (!rawJobs.length) return [];

  // Resolve each Naukri listing → get real company URL if "Apply on Company Website"
  onProgress(`↗ ${company.name}: resolving ${rawJobs.length} Naukri job link(s)...`);
  const detailPage = await browser.newPage();
  let resolved = 0;
  let easyApplyCount = 0;

  try {
    for (const job of rawJobs) {
      if (!job.link || !job.link.includes('naukri.com')) continue;
      try {
        const detail = await resolveNaukriJobDetail(detailPage, job.link);
        if (detail.externalLink) {
          job.link = detail.externalLink;
          job.source = 'careers-page';
          job.isEasyApply = false;
          resolved++;
        } else if (detail.isEasyApply) {
          job.isEasyApply = true;
          easyApplyCount++;
        }
      } catch { /* keep original naukri link on error */ }
    }
  } finally {
    await detailPage.close().catch(() => {});
  }

  if (resolved > 0) {
    onProgress(`↗ ${company.name}: resolved ${resolved} Naukri job(s) → actual company career page links`);
  }
  if (easyApplyCount > 0) {
    onProgress(`⚡ ${company.name}: ${easyApplyCount} Naukri Easy Apply job(s) detected`);
  }

  return rawJobs;
}

// ── Wellfound scraper (for startups) ─────────────────────────────────────────
async function scrapeWellfound(company, browser) {
  if (!company.wellfoundUrl) return [];
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.goto(company.wellfoundUrl, { waitUntil: 'networkidle2', timeout: 20000 });
    await page.waitForSelector('[class*="job"]', { timeout: 8000 }).catch(() => {});

    return await page.evaluate(() => {
      const jobs = [];
      document.querySelectorAll('a[href*="/jobs/"]').forEach(el => {
        const title = el.textContent?.trim();
        if (title && el.href && !jobs.find(j => j.link === el.href)) {
          jobs.push({
            title,
            jobId: el.href.split('/').pop() || String(Date.now()),
            link: el.href,
            location: 'India',
            description: '',
            source: 'wellfound',
            postedDate: new Date().toISOString().split('T')[0],
          });
        }
      });
      return jobs.slice(0, 10);
    });
  } catch {
    return [];
  } finally {
    await page.close();
  }
}

// ── Main scrape function ─────────────────────────────────────────────────────
export async function scrapeCompany(company, browser, onProgress) {
  onProgress(`Checking ${company.name}...`);
  let jobs = [];

  function finalizeJobs(rawJobs, sourceLabel) {
    const { eligible, excluded } = filterEligibleJobs(rawJobs, 15);
    const filteredOut = excluded.title + excluded.location + excluded.experience;

    if (filteredOut > 0) {
      const parts = [];
      if (excluded.location) parts.push(`${excluded.location} non-India`);
      if (excluded.experience) parts.push(`${excluded.experience} higher-experience`);
      if (excluded.title) parts.push(`${excluded.title} senior/ineligible`);
      onProgress(`ℹ ${company.name}: filtered out ${filteredOut} jobs (${parts.join(', ')})`);
    }

    if (eligible.length) {
      onProgress(`✓ ${company.name}: ${eligible.length} eligible jobs found (${sourceLabel})`);
    }

    return eligible;
  }

  // Track 1 – career page via Greenhouse/Lever APIs (fast, no browser)
  if (company.atsType === 'greenhouse' && company.atsSlug) {
    jobs = finalizeJobs(await scrapeGreenhouse(company.atsSlug), 'career page');
  } else if (company.atsType === 'lever' && company.atsSlug) {
    jobs = finalizeJobs(await scrapeLever(company.atsSlug), 'career page');
  }

  // Track 2 – Naukri (browser required, with external-link resolution)
  if (!jobs.length) {
    try {
      const raw = await scrapeNaukri(company, browser, onProgress);
      jobs = finalizeJobs(raw, 'Naukri');
    } catch (e) {
      onProgress(`⚠ Naukri error for ${company.name}: ${e.message}`);
    }
  }

  // Track 3 – Wellfound fallback for startups
  if (!jobs.length && company.type === 'startup' && company.wellfoundUrl) {
    try {
      jobs = finalizeJobs(await scrapeWellfound(company, browser), 'Wellfound');
    } catch {}
  }

  if (!jobs.length) onProgress(`○ ${company.name}: no matching jobs found`);

  // Analyse each job with AI (Gemini → OpenAI → keyword fallback)
  const analysed = [];
  for (const job of jobs) {
    const analysis = await analyzeJob(job);
    analysed.push({ ...job, companyId: company.id, ...analysis });
  }

  // Career-site jobs always float to the top
  return sortJobsBySource(analysed);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function stripHtml(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function today() {
  return new Date().toISOString().split('T')[0];
}
