// Connect to existing Chrome (remote debug) or launch a new browser
// To use existing Chrome, start it with:
//   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --no-first-run --no-default-browser-check
// Or add --remote-debugging-port=9222 to your Chrome shortcut.

export async function getBrowser({ headless = false, requireConnected = false } = {}) {
  const puppeteer = (await import('puppeteer')).default;
  const browserURL = process.env.CHROME_REMOTE_DEBUG_URL || 'http://localhost:9222';

  // Try connecting to existing Chrome on port 9222 first
  try {
    const res = await fetch(`${browserURL}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      const { webSocketDebuggerUrl } = await res.json();
      if (webSocketDebuggerUrl) {
        const browser = await puppeteer.connect({
          browserWSEndpoint: webSocketDebuggerUrl,
          defaultViewport: null, // use Chrome's own viewport
        });
        return { browser, connected: true };
      }
    }
  } catch {
    // Chrome not running with remote debugging — fall through to launch
  }

  if (requireConnected) {
    throw new Error(
      `Could not attach to your existing Chrome at ${browserURL}. Start Chrome with --remote-debugging-port=9222 and retry.`
    );
  }

  // Launch a new Puppeteer-controlled browser
  const browser = await puppeteer.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,800'],
    defaultViewport: { width: 1280, height: 800 },
  });
  return { browser, connected: false };
}

export async function getReusablePage(browser, { hosts = [] } = {}) {
  const pages = await browser.pages();

  const normalizedHosts = hosts.map(host => host.toLowerCase());
  const matchesHost = (url) => normalizedHosts.some(host => url.toLowerCase().includes(host));
  const isReusableBlank = (url) => url === 'about:blank' || url.startsWith('chrome://newtab');
  const isNormalPage = (url) => /^https?:|^about:blank|^chrome:\/\/newtab/.test(url);

  const hostPage = pages.find(page => matchesHost(page.url()));
  if (hostPage) {
    await hostPage.bringToFront().catch(() => {});
    return { page: hostPage, reusedExisting: true, reason: 'host-match' };
  }

  const blankPage = pages.find(page => isReusableBlank(page.url()));
  if (blankPage) {
    await blankPage.bringToFront().catch(() => {});
    return { page: blankPage, reusedExisting: true, reason: 'blank-tab' };
  }

  const normalPage = pages.find(page => isNormalPage(page.url()));
  if (normalPage) {
    await normalPage.bringToFront().catch(() => {});
    return { page: normalPage, reusedExisting: true, reason: 'existing-tab' };
  }

  const page = await browser.newPage();
  return { page, reusedExisting: false, reason: 'new-page' };
}
