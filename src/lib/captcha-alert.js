// Surfaces a CAPTCHA challenge to the user for manual solving — opens the
// blocked page in the persistent, noVNC-viewable Chrome (the same one
// wf-browser.sh runs for Wellfound's manual Cloudflare/login flow, on the
// server's virtual display :99, reachable only via a password-protected
// noVNC screen) and emails a link. This does not attempt to solve or bypass
// the challenge itself — only a human clicking through noVNC does that.
import { getSystemState, setSystemState } from './db.js';
import { sendPlainEmail } from './mailer.js';
import { getBrowser, getReusablePage } from './browser.js';

const NOVNC_URL = process.env.NOVNC_URL || 'http://187.127.188.153:6080/vnc.html';
const ALERT_RECIPIENT = process.env.ALERT_EMAIL || 'pulkitagarwal2015@gmail.com';
// A 5-minute cron would otherwise re-send this every single cycle until the
// challenge clears — one email per incident is enough to act on.
const COOLDOWN_MS = 3 * 60 * 60 * 1000;

export async function alertCaptchaBlocked({ site, blockedUrl, onProgress = () => {} }) {
  const stateKey = `captcha-alert:${site}`;
  const last = await getSystemState(stateKey).catch(() => null);
  if (last && Date.now() - new Date(last).getTime() < COOLDOWN_MS) {
    onProgress(`  ℹ Already alerted about a ${site} CAPTCHA recently — not re-sending.`);
    return { alerted: false, reason: 'cooldown' };
  }

  let tabOpened = false;
  try {
    // requireConnected: true — this must be the existing persistent VNC
    // browser, never a freshly-launched one nobody can see.
    const { browser } = await getBrowser({ headless: false, requireConnected: true });
    const { page } = await getReusablePage(browser, { hosts: [site] });
    await page.goto(blockedUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.bringToFront().catch(() => {});
    tabOpened = true;
  } catch (e) {
    onProgress(`  ⚠ Couldn't open the blocked page in the VNC browser: ${e.message}`);
  }

  try {
    await sendPlainEmail({
      to: ALERT_RECIPIENT,
      subject: `⚠ ${site} needs a CAPTCHA solved`,
      text: [
        `${site} is showing a CAPTCHA challenge and auto-apply is blocked.`,
        '',
        'Open this link and solve it:',
        NOVNC_URL,
        ...(process.env.VNC_PASSWORD ? [`VNC password: ${process.env.VNC_PASSWORD}`] : []),
        '',
        tabOpened
          ? 'The blocked page is already open there, waiting for you.'
          : `Couldn't auto-open the page — once connected, go to: ${blockedUrl}`,
        '',
        'Auto-apply will pick back up on its own on the next cycle once the challenge clears — no need to click anything else here.',
      ].join('\n'),
    });
    await setSystemState(stateKey, new Date().toISOString());
    onProgress(`  ✉ Emailed a CAPTCHA alert with a VNC link to ${ALERT_RECIPIENT}.`);
    return { alerted: true };
  } catch (e) {
    onProgress(`  ✗ Failed to send CAPTCHA alert email: ${e.message}`);
    return { alerted: false, reason: e.message };
  }
}
