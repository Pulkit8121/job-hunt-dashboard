// Connect to existing Chrome (remote debug) or launch a new browser.
// To use existing Chrome, start it with:
//   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --no-first-run --no-default-browser-check
// Or add --remote-debugging-port=9222 to your Chrome shortcut.

// useStealth: routes browser creation (both connect and launch) through
// puppeteer-extra + puppeteer-extra-plugin-stealth instead of plain
// puppeteer. The plugin's evasions (navigator.webdriver, plugins/mimeTypes
// spoofing, etc.) are applied via puppeteer-extra's own launch()/connect()
// wrappers — a browser object handed back from plain puppeteer never gets
// them, no matter what gets imported elsewhere. Found this wired up (stealth
// plugin imported and registered in generic-form-apply.js) but never actually
// taking effect, because the browser it was applying evasions to came from
// this function's plain `puppeteer` import — the registration was dead code.
export async function getBrowser({ headless = false, requireConnected = false, preferConnected = true, useStealth = false } = {}) {
  let puppeteer;
  if (useStealth) {
    puppeteer = (await import('puppeteer-extra')).default;
    const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
    puppeteer.use(StealthPlugin());
  } else {
    puppeteer = (await import('puppeteer')).default;
  }
  const browserURL = process.env.CHROME_REMOTE_DEBUG_URL || 'http://localhost:9222';

  // Try connecting to existing Chrome on port 9222 first. A CDP WebSocket
  // connect can hang forever if that Chrome is alive-but-wedged (e.g. stuck on
  // a captcha/dialog for days) — race it against a timeout so a broken shared
  // browser can never block every other automation that tries to reuse it.
  if (preferConnected) {
    try {
      const res = await fetch(`${browserURL}/json/version`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) {
        const { webSocketDebuggerUrl } = await res.json();
        if (webSocketDebuggerUrl) {
          const browser = await Promise.race([
            puppeteer.connect({
              browserWSEndpoint: webSocketDebuggerUrl,
              defaultViewport: null, // use Chrome's own viewport
              protocolTimeout: 120000,
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('puppeteer.connect timed out — existing Chrome is unresponsive')), 25000)
            ),
          ]);
          return { browser, connected: true };
        }
      }
    } catch {
      // Chrome not running (or unresponsive) with remote debugging — fall through to launch
    }
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

// browser.close() can hang indefinitely if Chrome is unresponsive (confirmed
// root cause of a 4-day resource leak: every route did a bare
// `await browser.close().catch(() => {})` with no timeout, so under any CPU
// starvation Chrome never acknowledged the close request, the await never
// resolved, and the launched-fresh Chrome process (never attached to the VNC
// session) just kept running forever — one leaked per pipeline run, roughly
// every 4 hours, until the 1-core server's swap filled completely).
// Race close() against a timeout, then SIGKILL the underlying OS process
// directly if it didn't shut down in time — this can never hang.
export async function closeBrowserSafely(browser, connected) {
  if (!browser || connected) return; // never close a browser we don't own (e.g. the shared VNC session)
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('browser.close() timed out')), 8000)),
    ]);
  } catch {
    try { browser.process()?.kill('SIGKILL'); } catch {}
  }
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
