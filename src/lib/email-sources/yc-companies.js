// Y Combinator's own public company directory, mirrored as static JSON by
// yc-oss/api (https://github.com/yc-oss/api) — an open-source project that
// fetches YC's own public Algolia index once daily via GitHub Actions and
// republishes it as flat JSON files. This is YC's own published directory of
// publicly-launched portfolio companies, not scraped personal data: every
// company here chose to be listed on ycombinator.com/companies.
//
// Unlike outreach-discovery.js's Bing-search fallback (which has to guess
// which search result is the right company — a real failure mode for
// obscure names), this source already has the company's real website
// directly from YC, so it can be fed straight to findContactForCompany()
// as `careersUrl`, skipping the search step and its wrong-company risk
// entirely.
const ALL_COMPANIES_URL = 'https://yc-oss.github.io/api/companies/all.json';
const FETCH_TIMEOUT = 20000;

function regionsToTag(regions = []) {
  if (regions.includes('United States of America') || regions.includes('America / Canada')) return 'us';
  if (regions.some(r => ['Europe', 'United Kingdom', 'France', 'Germany'].includes(r))) return 'europe';
  if (regions.includes('India')) return 'india';
  if (regions.some(r => /remote/i.test(r))) return 'remote';
  return 'other';
}

function regionsToLocation(regions = [], allLocations) {
  return allLocations || regions[0] || 'Remote';
}

// Returns [{ name, website, region, location, isHiring, batch }] for active
// YC companies with a real website. `onlyHiring` defaults to true since
// that's both the more relevant target and a much smaller, faster set to
// process per run than all 4000+ active companies.
export async function fetchYcCompanies({ onlyHiring = true } = {}) {
  const res = await fetch(ALL_COMPANIES_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!res.ok) throw new Error(`yc-oss API ${res.status}`);
  const all = await res.json();

  return all
    .filter(c => c.status === 'Active' && c.website && (!onlyHiring || c.isHiring))
    .map(c => ({
      name: c.name,
      website: c.website,
      region: regionsToTag(c.regions),
      location: regionsToLocation(c.regions, c.all_locations),
      isHiring: !!c.isHiring,
      batch: c.batch || null,
    }));
}
