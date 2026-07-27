// Connect to existing Chrome (remote debug) or launch a new browser
// To use existing Chrome, start it with:
//   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --no-first-run --no-default-browser-check
// Or add --remote-debugging-port=9222 to your Chrome shortcut.

import { initNodriverBrowser, createEnhancedPage } from './nodriver-browser.js';
import { createAntiDetectBrowser } from './anti-detect-browser.js';

export async function getBrowser({ headless = false, requireConnected = false, preferConnected = true } = {}) {
  // Try enhanced anti-detection browser first
  try {
    const result = await createAntiDetectBrowser({ headless });
    return result;
  } catch (antiDetectError) {
    console.warn('Enhanced anti-detection browser failed, falling back to existing methods:', antiDetectError.message);
    
    // Fall back to original nodriver implementation
    try {
      const result = await initNodriverBrowser({ headless, requireConnected });
      return result;
    } catch (nodriverError) {
      console.warn('Nodriver initialization failed, falling back to Puppeteer:', nodriverError.message);
      
      // Fall back to Puppeteer
      const puppeteer = (await import('puppeteer')).default;
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
                }),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('puppeteer.connect timed out — existing Chrome is unresponsive')), 5000)
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
  }
}

export async function getReusablePage(browser, { hosts = [] } = {}) {
  // This function is primarily for Puppeteer compatibility
  // When using nodriver, we'll create new pages as needed 
  // (nodriver doesn't support shared page reuse the same way)
  
  const page = await browser.newPage();
  
  // Apply enhanced settings that help avoid detection
  await applyAntiDetect(page);
  
  return { page, reusedExisting: false, reason: 'new-page' };
}
