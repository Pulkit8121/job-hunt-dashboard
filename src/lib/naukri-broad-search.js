// Broad, paginated Naukri discovery.
//
// Replaces the per-company search loop for discovery purposes. That loop
// passed a `companies=<name>` query param that Naukri ignores, so all 918
// tracked companies ran effectively the same generic role+city search and got
// the same results back — 5,298 stored job rows collapsing to 361 unique
// listings, with one listing saved under 113 different companies.
//
// Two changes fix that:
//   1. Search role x city ONCE each and paginate, instead of once per company.
//      Pagination is where genuinely new listings come from.
//   2. Attribute each job to the company that actually posted it (read off the
//      job card) rather than the company we happened to be searching under.
import { PROFILE } from './profile.js';
import { openNaukriPage, extractNaukriCards } from './naukri.js';
import { slugifyCompanyId } from './company-utils.js';

// Naukri paginates by appending -<n> to the search path; page 1 has no suffix.
export function buildBroadSearchUrl(roleSlug, citySlug, page = 1) {
  const base = `https://www.naukri.com/${roleSlug}-jobs-in-${citySlug}`;
  const path = page > 1 ? `${base}-${page}` : base;
  const params = new URLSearchParams({
    experience: String(PROFILE.minExperienceYears),
    maxExperience: String(PROFILE.maxExperienceYears),
  });
  return `${path}?${params.toString()}`;
}

// Yields raw job objects tagged with their true posting company.
// onProgress(msg) for log lines; signal to abort mid-run.
export async function scrapeNaukriBroad(browser, {
  roles = PROFILE.scrapeRoles,
  cities = PROFILE.preferredCities,
  pagesPerSearch = 5,
  onProgress = () => {},
  signal,
} = {}) {
  const page = await browser.newPage();
  const byLink = new Map();
  let searches = 0;

  try {
    for (const role of roles) {
      for (const city of cities) {
        if (signal?.aborted) break;
        searches++;
        let newForThisSearch = 0;

        for (let p = 1; p <= pagesPerSearch; p++) {
          if (signal?.aborted) break;
          const url = buildBroadSearchUrl(role.slug, city.slug, p);
          let cards = [];
          try {
            await openNaukriPage(page, url);
            cards = await extractNaukriCards(page);
          } catch (e) {
            onProgress(`⚠ ${role.label} / ${city.label} p${p}: ${e.message.slice(0, 70)}`);
            break;
          }
          if (!cards.length) break; // ran past the last page

          let newOnPage = 0;
          for (const card of cards) {
            if (!card.title || !card.link) continue;
            const key = card.link.split('?')[0];
            if (byLink.has(key)) continue;

            const postingCompany = (card.companyName || '').trim();
            byLink.set(key, {
              title: card.title,
              jobId: card.jobId || key.split('-').pop() || key,
              link: card.link,
              location: card.location || city.label,
              experienceText: card.experienceText || '',
              description: card.description || '',
              source: 'naukri',
              isEasyApply: false,
              postedDate: new Date().toISOString().split('T')[0],
              // Attribution: the company on the card, not the search context.
              postingCompanyName: postingCompany,
              companyId: postingCompany ? slugifyCompanyId(postingCompany) : 'naukri-unattributed',
            });
            newOnPage++;
            newForThisSearch++;
          }

          // A page that adds nothing new means we've caught up to listings the
          // earlier searches already returned — stop paging this combination.
          if (newOnPage === 0) break;

          // Pacing: pncodes10's client needed ~1s between search pages to avoid
          // tripping Naukri's reCAPTCHA on rapid querying.
          await new Promise(r => setTimeout(r, 900 + Math.random() * 600));
        }

        if (newForThisSearch) {
          onProgress(`+ ${newForThisSearch} new from ${role.label} / ${city.label} (running total ${byLink.size})`);
        }
      }
      if (signal?.aborted) break;
    }
  } finally {
    await page.close().catch(() => {});
  }

  onProgress(`ℹ ${searches} role/city search(es) → ${byLink.size} unique listing(s).`);
  return Array.from(byLink.values());
}
