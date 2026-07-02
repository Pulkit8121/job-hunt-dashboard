import { analyzeJob } from './ai.js';
import { filterEligibleJobs, isRelevantJob } from './matcher.js';
import { scrapeCompany, sortJobsBySource } from './scraper.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const JOB_LINK_HINT = /(job|jobs|career|careers|opening|position|role|vacancy|requisition|opportunity|apply)/i;
const COMPANY_SOURCES = new Set(['career-agent', 'careers-page']);

async function prepareCareerPage(page) {
  await page.setUserAgent(USER_AGENT);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let total = 0;
      const step = 600;
      const max = 4800;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        if (total >= max) {
          clearInterval(timer);
          resolve();
        }
      }, 120);
    });
  }).catch(() => {});
}

async function openCareerPage(page, url) {
  await prepareCareerPage(page);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await autoScroll(page);
}

function normalizeText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function getExactJobKey(job) {
  return job.link || `${job.title}:${job.location}:${job.source}`;
}

function getSemanticJobKey(job) {
  return `${normalizeText(job.title)}::${normalizeText(job.location)}`;
}

function preferJob(nextJob, currentJob) {
  const nextIsCompany = COMPANY_SOURCES.has(nextJob.source);
  const currentIsCompany = COMPANY_SOURCES.has(currentJob.source);

  if (nextIsCompany && !currentIsCompany) return nextJob;
  if (!nextIsCompany && currentIsCompany) return currentJob;

  return (nextJob.description || '').length > (currentJob.description || '').length ? nextJob : currentJob;
}

function dedupeJobs(jobs) {
  const exactSeen = new Map();
  const semanticSeen = new Map();

  for (const job of jobs) {
    const exactKey = getExactJobKey(job);
    const semanticKey = getSemanticJobKey(job);
    const existingExact = exactSeen.get(exactKey);
    const existingSemantic = semanticSeen.get(semanticKey);

    if (existingExact) {
      const preferred = preferJob(job, existingExact);
      exactSeen.set(exactKey, preferred);
      semanticSeen.set(semanticKey, preferred);
      continue;
    }

    if (existingSemantic) {
      const preferred = preferJob(job, existingSemantic);
      semanticSeen.set(semanticKey, preferred);
      exactSeen.set(getExactJobKey(preferred), preferred);
      continue;
    }

    exactSeen.set(exactKey, job);
    semanticSeen.set(semanticKey, job);
  }

  return Array.from(new Set(semanticSeen.values()));
}

async function extractCareerCandidates(page) {
  return page.evaluate(({ jobLinkHintSource }) => {
    const hint = new RegExp(jobLinkHintSource, 'i');
    const out = [];
    const seen = new Set();

    function clean(text) {
      return String(text || '').replace(/\s+/g, ' ').trim();
    }

    function normalizeStructuredLocation(value) {
      if (!value) return '';
      if (typeof value === 'string') return clean(value);
      if (Array.isArray(value)) {
        return value.map(normalizeStructuredLocation).filter(Boolean).join('; ');
      }
      if (typeof value !== 'object') return '';

      const address = value.address || value.jobLocation || value.location || value;
      if (typeof address === 'string') return clean(address);
      if (!address || typeof address !== 'object') return '';

      return clean([
        address.name,
        address.addressLocality,
        address.addressRegion,
        address.addressCountry,
        address.streetAddress,
      ].filter(Boolean).join(', '));
    }

    function push(job) {
      const title = clean(job.title);
      const link = clean(job.link);
      if (!title || !link) return;
      const key = `${title}::${link}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        title,
        link,
        location: clean(job.location),
        description: clean(job.description).slice(0, 1200),
      });
    }

    function visitStructured(node) {
      if (!node) return;

      if (Array.isArray(node)) {
        node.forEach(visitStructured);
        return;
      }

      if (typeof node !== 'object') return;

      const type = Array.isArray(node['@type']) ? node['@type'].join(' ') : node['@type'];
      if (type && /jobposting/i.test(String(type))) {
        push({
          title: node.title || node.name,
          link: node.url || node.sameAs,
          location: normalizeStructuredLocation(node.jobLocation || node.applicantLocationRequirements || node.location),
          description: node.description,
        });
      }

      Object.values(node).forEach(visitStructured);
    }

    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        visitStructured(JSON.parse(script.textContent || 'null'));
      } catch {}
    }

    const anchors = Array.from(document.querySelectorAll('a[href]'));
    for (const anchor of anchors) {
      const href = anchor.href || '';
      if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;

      const title = clean(anchor.textContent || anchor.getAttribute('title') || anchor.getAttribute('aria-label'));
      if (title.length < 3 || title.length > 160) continue;

      const card = anchor.closest('article, li, div, section, tr');
      const cardText = clean(card?.innerText || '');
      const linkHintText = `${href} ${title} ${cardText}`.slice(0, 1200);
      if (!hint.test(linkHintText)) continue;

      const location = clean(
        card?.querySelector('[class*="location"], [class*="loc"], [data-qa*="location"], [data-testid*="location"]')?.textContent || ''
      );

      push({
        title,
        link: href,
        location,
        description: cardText,
      });
    }

    return out.slice(0, 80);
  }, { jobLinkHintSource: JOB_LINK_HINT.source });
}

async function enrichCareerCandidate(page, candidate) {
  try {
    await openCareerPage(page, candidate.link);
    return await page.evaluate((fallback) => {
      function clean(text) {
        return String(text || '').replace(/\s+/g, ' ').trim();
      }

      const title = clean(
        document.querySelector('h1, h2, [class*="title"], [data-qa*="title"]')?.textContent || fallback.title
      );
      const location = clean(
        document.querySelector('[class*="location"], [class*="loc"], [data-qa*="location"], [data-testid*="location"]')?.textContent || fallback.location
      );
      const description = clean(
        document.querySelector('main [class*="description"], article, main, [data-qa*="description"], [class*="job-description"]')?.textContent ||
        document.body?.innerText ||
        fallback.description
      );
      const experienceText = clean(
        document.querySelector('[class*="exp"] [title], [class*="experience"], [data-qa*="experience"]')?.textContent || ''
      );

      return {
        title,
        link: fallback.link,
        location,
        description: description.slice(0, 4000),
        experienceText,
      };
    }, candidate);
  } catch {
    return candidate;
  }
}

async function scrapeCareerSiteWithAgent(company, browser, onProgress) {
  if (!company.careersUrl) return [];

  onProgress(`🤖 ${company.name}: crawling career site for missed jobs...`);

  const listingPage = await browser.newPage();
  const detailPage = await browser.newPage();

  try {
    await openCareerPage(listingPage, company.careersUrl);
    const candidates = await extractCareerCandidates(listingPage);
    let relevantCandidates = candidates.filter(candidate => isRelevantJob(candidate.title)).slice(0, 20);

    if (!relevantCandidates.length) {
      const boardLinks = dedupeJobs(
        candidates.filter(candidate =>
          JOB_LINK_HINT.test(`${candidate.title} ${candidate.link}`) &&
          candidate.link !== company.careersUrl &&
          !isRelevantJob(candidate.title)
        )
      ).slice(0, 3);

      for (const boardLink of boardLinks) {
        onProgress(`🤖 ${company.name}: following career board link ${boardLink.title || boardLink.link}`);
        await openCareerPage(listingPage, boardLink.link);
        const nestedCandidates = await extractCareerCandidates(listingPage);
        relevantCandidates = dedupeJobs([
          ...relevantCandidates,
          ...nestedCandidates.filter(candidate => isRelevantJob(candidate.title)),
        ]).slice(0, 20);
        if (relevantCandidates.length >= 8) break;
      }
    }

    if (!relevantCandidates.length) {
      onProgress(`ℹ ${company.name}: agent did not find extra job links on the career page`);
      return [];
    }

    onProgress(`🤖 ${company.name}: found ${relevantCandidates.length} possible career-site job links`);

    const enriched = [];
    for (const candidate of relevantCandidates.slice(0, 12)) {
      const job = await enrichCareerCandidate(detailPage, candidate);
      enriched.push({
        ...job,
        source: 'career-agent',
        postedDate: today(),
      });
    }

    return dedupeJobs(enriched);
  } finally {
    await listingPage.close().catch(() => {});
    await detailPage.close().catch(() => {});
  }
}

export async function scrapeCompanyWithAgent(company, browser, onProgress) {
  onProgress(`🤖 Agent scanning ${company.name}...`);
  const rawAgentJobs = await scrapeCareerSiteWithAgent(company, browser, onProgress);
  const { eligible, excluded } = filterEligibleJobs(rawAgentJobs, 30);
  const filteredOut = excluded.title + excluded.location + excluded.experience;

  if (filteredOut > 0) {
    const parts = [];
    if (excluded.location) parts.push(`${excluded.location} non-India`);
    if (excluded.experience) parts.push(`${excluded.experience} higher-experience`);
    if (excluded.title) parts.push(`${excluded.title} senior/ineligible`);
    onProgress(`ℹ ${company.name}: agent filtered out ${filteredOut} extra jobs (${parts.join(', ')})`);
  }

  const analysedCareerJobs = [];
  for (const job of eligible) {
    const analysis = await analyzeJob(job);
    analysedCareerJobs.push({ ...job, companyId: company.id, ...analysis });
  }

  if (analysedCareerJobs.length > 0) {
    onProgress(`🤖 ${company.name}: found ${analysedCareerJobs.length} eligible jobs on the company career site`);
  } else {
    onProgress(`ℹ ${company.name}: no eligible company-site jobs found, falling back to other sources`);
  }

  const baseline = await scrapeCompany(company, browser, onProgress);
  const fallbackJobs = analysedCareerJobs.length > 0
    ? baseline.filter(job => job.source !== 'naukri')
    : baseline;

  if (analysedCareerJobs.length > 0 && baseline.some(job => job.source === 'naukri')) {
    onProgress(`ℹ ${company.name}: skipped Naukri duplicates because company-site jobs were found`);
  }

  const merged = sortJobsBySource(dedupeJobs([...analysedCareerJobs, ...fallbackJobs]))
    .slice(0, 40);

  if (analysedCareerJobs.length > 0) {
    onProgress(`🤖 ${company.name}: prioritised company website jobs before fallback sources`);
  } else if (!merged.length) {
    onProgress(`ℹ ${company.name}: agent found no eligible jobs`);
  }

  return merged;
}

function today() {
  return new Date().toISOString().split('T')[0];
}
