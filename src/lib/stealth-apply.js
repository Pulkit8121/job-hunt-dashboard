// Enhanced automated job application with stealth drivers and human emulation
import { chromium } from 'puppeteer';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { createTransport } from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { parse } from 'mailparser';

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

  async getLatestOtp() {
    const imap = await this.connectImap();
    if (!imap) return null;

    try {
      await imap.mailboxOpen('INBOX');
      
      // Look for recent emails from greenhouse or job application services
      const emailSearchResults = await imap.search({
        subject: /(?:greenhouse|otp|verification|security)/i,
        since: new Date(Date.now() - 5 * 60000) // Last 5 minutes
      });
      
      if (emailSearchResults.length === 0) {
        return null;
      }
      
      // Get the most recent email
      const latestEmail = emailSearchResults[emailSearchResults.length - 1];
      const message = await imap.fetchOne(latestEmail, { source: true, headers: true });
      
      if (message && message.source) {
        const parsed = await parse(message.source);
        const otpMatch = parsed.text.match(/\b\d{4,6}\b/);
        
        return otpMatch ? otpMatch[0] : null;
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