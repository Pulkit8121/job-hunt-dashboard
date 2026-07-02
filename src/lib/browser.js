// Connect to existing Chrome (remote debug) or launch a new browser
// To use existing Chrome, start it with:
//   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --no-first-run --no-default-browser-check
// Or add --remote-debugging-port=9222 to your Chrome shortcut.

export async function getBrowser({ headless = false } = {}) {
  const puppeteer = (await import('puppeteer')).default;

  // Try connecting to existing Chrome on port 9222 first
  try {
    const res = await fetch('http://localhost:9222/json/version', {
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

  // Launch a new Puppeteer-controlled browser
  const browser = await puppeteer.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,800'],
    defaultViewport: { width: 1280, height: 800 },
  });
  return { browser, connected: false };
}
