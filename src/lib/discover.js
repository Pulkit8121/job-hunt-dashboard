import { readCompanies, addCompany } from './db.js';
import {
  buildCompanyRecord,
  buildNaukriRoleSearchUrl,
  DISCOVERY_CITY_SEARCHES,
  DISCOVERY_ROLE_SEARCHES,
} from './company-utils.js';
import { extractNaukriCards, openNaukriPage } from './naukri.js';

function inferWorkMode(workModeText = '') {
  if (workModeText.includes('remote') || workModeText.includes('work from home')) return 'remote';
  if (workModeText.includes('hybrid')) return 'hybrid';
  if (workModeText.includes('onsite') || workModeText.includes('in office')) return 'onsite';
  return 'unknown';
}

// Search Naukri across multiple roles and cities, then add newly discovered companies.
export async function discoverCompanies(browser, onProgress) {
  onProgress('🔍 Auto-adding companies from Naukri...');

  const page = await browser.newPage();
  const discovered = [];

  try {
    for (const role of DISCOVERY_ROLE_SEARCHES) {
      for (const city of DISCOVERY_CITY_SEARCHES) {
        const url = buildNaukriRoleSearchUrl(role.slug, city.slug);
        onProgress(`↗ Searching ${role.label} in ${city.label}...`);

        try {
          await openNaukriPage(page, url);
          const cards = await extractNaukriCards(page);

          for (const card of cards) {
            if (!card.companyName || card.companyName.length < 2) continue;
            discovered.push({
              name: card.companyName,
              location: card.location || city.label,
              salary: card.salary,
              workModeText: card.workModeText,
            });
          }
        } catch (e) {
          onProgress(`⚠ Skipped ${role.label} in ${city.label}: ${e.message}`);
        }
      }
    }
  } finally {
    await page.close();
  }

  const existing = await readCompanies();
  const existingNames = new Set(existing.map(company => company.name.toLowerCase().trim()));
  const seen = new Set();
  let added = 0;
  let alreadyTracked = 0;
  let overlapCount = 0;

  for (const found of discovered) {
    const key = found.name.toLowerCase().trim();
    if (!found.name) continue;
    if (existingNames.has(key)) {
      alreadyTracked++;
      continue;
    }
    if (seen.has(key)) {
      overlapCount++;
      continue;
    }
    seen.add(key);

    const company = buildCompanyRecord({
      name: found.name,
      workMode: inferWorkMode(found.workModeText),
      locations: [found.location || 'Bengaluru'],
      salaryRange: found.salary || undefined,
      autoDiscovered: true,
    });

    try {
      await addCompany(company);
      existingNames.add(key);
      added++;
      onProgress(`＋ Added ${company.name} · ${company.workMode} · ${company.locations[0]}`);
    } catch {
      // Ignore duplicates caused by overlapping search result pages.
    }
  }

  onProgress(`ℹ Found ${seen.size + alreadyTracked} unique companies in results · ${alreadyTracked} already tracked · ${overlapCount} repeated across searches`);
  onProgress(added > 0 ? `✓ Added ${added} new companies from Naukri` : 'ℹ No new companies found');
  return added;
}
