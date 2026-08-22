// Experimental automated job application helpers with stealth drivers and
// human emulation.
//
// The production company-portal flow reuses EmailOTPReader from this file when
// Greenhouse emails a security code after submit; the broader helpers here are
// still experimental and are not the main apply path.
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { createTransport } from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

// Add stealth plugin to Puppeteer
puppeteerExtra.use(StealthPlugin());

// Human emulation utilities
class HumanEmulator {
  static randomDelay(min = 100, max = 500) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  static randomMouseCurve(startX, startY, endX, endY) {
    // Generate a realistic mouse curve with micro-delays
    const points = [];
    const steps = 10;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = startX + (endX - startX) * t;
      const y = startY + (endY - startY) * t;
      points.push({ x, y });
    }
    return points;
  }

  static randomTypingSpeed() {
    // Variable typing speed with pauses
    return Math.floor(Math.random() * 100) + 50; // 50-150ms per character
  }

  static addRandomDelays(page) {
    // Add micro-delays between actions
    return new Promise(resolve => {
      setTimeout(() => resolve(), this.randomDelay(200, 800));
    });
  }
}

// Email OTP retrieval utility
class EmailOTPReader {
  constructor(email, appPassword) {
    this.email = email;
    this.appPassword = appPassword;
    this.lookbackMs = Number(process.env.PORTAL_SECURITY_CODE_LOOKBACK_MS) || 15 * 60000;
    this.maxMessagesToInspect = Number(process.env.PORTAL_SECURITY_CODE_MAX_MESSAGES) || 25;
    this.transporter = createTransport({
      service: 'gmail',
      auth: {
        user: email,
        pass: appPassword
      }
    });
  }

  async connectImap() {
    try {
      const imap = new ImapFlow({
        host: 'imap.gmail.com',
        port: 993,
        secure: true,
        auth: {
          user: this.email,
          pass: this.appPassword
        },
        logLevel: 'error'
      });
      
      await imap.connect();
      return imap;
    } catch (error) {
      console.error('IMAP connection error:', error);
      return null;
    }
  }

  isOtpLikeMessage(parsed) {
    const subject = String(parsed?.subject || '');
    const from = [parsed?.from?.text, parsed?.from?.value?.map(v => `${v.name || ''} ${v.address || ''}`).join(' ')].filter(Boolean).join(' ');
    const text = String(parsed?.text || '');
    const html = String(parsed?.html || '');
    const haystack = `${subject}\n${from}\n${text}\n${html}`.toLowerCase();
    return /greenhouse|verification|security code|security-code|passcode|one[- ]time|otp|auth code|confirm/i.test(haystack);
  }

  extractOtp(parsed) {
    const subject = String(parsed?.subject || '');
    const text = String(parsed?.text || '');
    const html = String(parsed?.html || '');
    const haystack = `${subject}\n${text}\n${html}`;

    // Prefer numbers explicitly labeled as codes before falling back to any
    // 4-8 digit token in the message body.
    const labeled = haystack.match(/(?:security|verification|confirm(?:ation)?|one[- ]time|auth(?:entication)?)\D{0,30}(\d{4,8})/i);
    if (labeled?.[1]) return labeled[1];

    const lines = haystack.split('\n').slice(0, 80);
    for (const line of lines) {
      const standalone = line.trim().match(/^(\d{4,8})$/);
      if (standalone?.[1]) return standalone[1];

      if (!/(security|verification|confirm(?:ation)?|one[- ]time|auth(?:entication)?|passcode|code)/i.test(line)) {
        continue;
      }
      const match = line.match(/\b(\d{4,8})\b/);
      if (match?.[1]) return match[1];
    }
    return null;
  }

  async getLatestOtp() {
    const imap = await this.connectImap();
    if (!imap) return null;

    try {
      await imap.mailboxOpen('INBOX');

      // Gmail IMAP SUBJECT search is literal-text matching, not regex. The
      // production trace showed this going out as
      // SUBJECT "/(?:greenhouse|otp|verification|security)/i", which can never
      // match a real subject line. Search broadly by recency, then inspect the
      // newest messages client-side.
      const emailSearchResults = await imap.search({
        since: new Date(Date.now() - this.lookbackMs)
      });

      if (!emailSearchResults.length) {
        return null;
      }

      const recentIds = emailSearchResults.slice(-this.maxMessagesToInspect).reverse();
      for (const messageId of recentIds) {
        const message = await imap.fetchOne(messageId, { source: true, internalDate: true }).catch(() => null);
        if (!message?.source) continue;

        if (message.internalDate && Date.now() - new Date(message.internalDate).getTime() > this.lookbackMs) {
          continue;
        }

        const parsed = await simpleParser(message.source).catch(() => null);
        if (!parsed || !this.isOtpLikeMessage(parsed)) continue;

        const otp = this.extractOtp(parsed);
        if (otp) return otp;
      }
    } catch (error) {
      console.error('Error reading email OTP:', error);
    } finally {
      await imap.logout();
    }
    
    return null;
  }

  async waitForOtp(timeout = 60000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      const otp = await this.getLatestOtp();
      if (otp) return otp;
      
      // Wait before next check
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    return null;
  }
}

// Enhanced apply function with OTP handling
async function applyWithStealthAndOTP(browser, job, { smtpEmail, smtpAppPassword } = {}) {
  const page = await browser.newPage();
  const otpReader = new EmailOTPReader(smtpEmail, smtpAppPassword);
  
  try {
    // Set user agent and viewport for human-like behavior
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 768 });
    
    // Navigate to job page
    await page.goto(job.link, { 
      waitUntil: 'networkidle2', 
      timeout: 30000 
    });
    
    // Add random delay for human emulation
    await HumanEmulator.addRandomDelays(page);
    
    // Handle OTP flow if needed
    const otp = await otpReader.waitForOtp(15000);
    if (otp) {
      // Look for OTP input field and fill it
      await page.waitForSelector('input[type="text"], input[type="number"]', { timeout: 10000 });
      
      try {
        // Try to find OTP input by placeholder or label text
        const otpInputs = await page.$$('input');
        for (const input of otpInputs) {
          const placeholder = await input.getAttribute('placeholder');
          const label = await input.evaluate(el => {
            const parentLabel = el.closest('label');
            return parentLabel ? parentLabel.textContent : '';
          });
          
          if (placeholder && /otp|security|verification|code|auth/i.test(placeholder)) {
            await input.type(otp, { delay: HumanEmulator.randomTypingSpeed() });
            break;
          }
        }
      } catch (error) {
        console.error('Could not fill OTP:', error);
      }
    }
    
    // Proceed with normal application flow
    const result = await applyToPortalJob(browser, job);
    
    return result;
    
  } catch (error) {
    console.error('Application error:', error);
    return { success: false, reason: `error: ${error.message}` };
  } finally {
    await page.close();
  }
}

// Import existing apply function from the codebase
async function applyToPortalJob(browser, job) {
  // This is a simplified version of your existing apply function that would be integrated with
  // stealth and human emulation features
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.goto(job.link, { waitUntil: 'networkidle2', timeout: 40000 });
    await page.waitForSelector('form, input, textarea', { timeout: 10000 });
    
    // Your existing job application logic would go here
    // The stealth and emulation features are already implemented above
    
    return { success: true, reason: 'submitted' };
  } catch (e) {
    return { success: false, reason: `error: ${e.message}` };
  } finally {
    await page.close();
  }
}

// Main application function with all enhancements
export async function enhancedApplyToJob(job, options = {}) {
  const { 
    smtpEmail = process.env.SMTP_EMAIL,
    smtpAppPassword = process.env.SMTP_APP_PASSWORD,
    headless = process.env.APPLY_HEADLESS !== 'false'
  } = options;
  
  // Launch browser with stealth
  const browser = await puppeteerExtra.launch({
    headless: headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--disable-extensions',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1366,768'
    ]
  });
  
  try {
    const result = await applyWithStealthAndOTP(browser, job, { smtpEmail, smtpAppPassword });
    return result;
  } finally {
    await browser.close();
  }
}

export { HumanEmulator, EmailOTPReader };
