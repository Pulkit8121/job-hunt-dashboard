const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function prep(page) {
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
}

export async function linkedInLogin(page, email, password) {
  await prep(page);
  await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('#username', { timeout: 10000 });

  await page.click('#username');
  await page.type('#username', email, { delay: 80 });
  await delay(400);
  await page.click('#password');
  await page.type('#password', password, { delay: 80 });
  await delay(300);

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
    page.click('[type="submit"]'),
  ]);

  const url = page.url();
  if (url.includes('/login') || url.includes('/checkpoint')) {
    throw new Error('LinkedIn login failed or requires verification — open the browser and complete it manually, then retry.');
  }
}

// Scrape people from a LinkedIn search results page (already navigated to)
async function extractPeopleFromPage(page) {
  return page.evaluate(() => {
    const results = [];
    const cards = document.querySelectorAll(
      '.reusable-search__result-container, [data-chameleon-result-urn], li.reusable-search__result-container'
    );

    for (const card of cards) {
      const nameEl = card.querySelector(
        '[class*="actor-name"], [class*="entity-result__title-text"] a, .app-aware-link span[aria-hidden="true"]'
      );
      const titleEl = card.querySelector(
        '[class*="entity-result__primary-subtitle"], [class*="subline-level-1"]'
      );
      const linkEl = card.querySelector('a[href*="/in/"]');

      const name = (nameEl?.textContent || '').replace(/\s+/g, ' ').trim();
      const title = (titleEl?.textContent || '').replace(/\s+/g, ' ').trim();
      let profileUrl = linkEl?.href || '';
      // Strip query params from profile URL
      if (profileUrl) profileUrl = profileUrl.split('?')[0].replace(/\/$/, '');

      if (name && profileUrl && !name.toLowerCase().includes('linkedin member')) {
        results.push({ name, title, profileUrl });
      }
    }
    return results;
  });
}

// Search people for one company + one search type. Returns array of { name, title, profileUrl }
export async function scrapeLinkedInPeople(page, searchUrl, onProgress) {
  await prep(page);
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

  // Wait for results to load
  await Promise.race([
    page.waitForSelector('[class*="entity-result"]', { timeout: 8000 }),
    page.waitForSelector('[class*="search-results"]', { timeout: 8000 }),
  ]).catch(() => {});

  await delay(1500);

  const people = await extractPeopleFromPage(page);
  return people.slice(0, 8); // max 8 people per search type
}

// Send a connection request to a LinkedIn profile. Returns { success, reason }
export async function sendConnectionRequest(page, profileUrl, message) {
  try {
    await prep(page);
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await delay(1500 + Math.random() * 1000);

    // Find Connect button — it may be in the main actions or under "More"
    const connected = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      for (const btn of btns) {
        const text = (btn.textContent || '').trim().toLowerCase();
        if (text === 'connect') {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!connected) {
      // Try "More" dropdown first
      const moreClicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        for (const btn of btns) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (text === 'more') { btn.click(); return true; }
        }
        return false;
      });

      if (moreClicked) {
        await delay(600);
        const connectInDropdown = await page.evaluate(() => {
          const items = Array.from(document.querySelectorAll('[role="menuitem"], li button, .artdeco-dropdown__item'));
          for (const item of items) {
            const text = (item.textContent || '').trim().toLowerCase();
            if (text === 'connect') { item.click(); return true; }
          }
          return false;
        });
        if (!connectInDropdown) return { success: false, reason: 'Connect option not found in dropdown' };
      } else {
        return { success: false, reason: 'Connect button not found (may already be connected or pending)' };
      }
    }

    await delay(800);

    // Choose "Add a note"
    const addNote = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      for (const btn of btns) {
        const text = (btn.textContent || '').trim().toLowerCase();
        if (text.includes('add a note')) { btn.click(); return true; }
      }
      return false;
    });

    if (addNote) {
      await delay(600);
      // Type the note (LinkedIn 300-char limit)
      const noteText = message.slice(0, 295);
      const textArea = await page.$('textarea[name="message"], #custom-message, textarea');
      if (textArea) {
        await textArea.click();
        await textArea.type(noteText, { delay: 30 });
        await delay(400);
      }
    }

    // Click Send
    await delay(400);
    const sent = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      for (const btn of btns) {
        const text = (btn.textContent || '').trim().toLowerCase();
        if (text === 'send' || text === 'send invitation') { btn.click(); return true; }
      }
      return false;
    });

    if (!sent) return { success: false, reason: 'Could not click Send — modal may have changed' };

    await delay(1000);
    return { success: true, reason: 'Connection request sent with personalized note' };
  } catch (e) {
    return { success: false, reason: e.message };
  }
}
