// Nodriver-based browser automation for enhanced CAPTCHA handling
// This module provides a more robust browser automation solution that 
// can better handle invisible captchas and anti-bot detection

import { createBrowser } from 'nodriver';
import { captchaSolver } from './captcha-solver.js';

const BROWSER_CONFIG = {
  headless: false,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-infobars',
    '--window-position=0,0',
    '--ignore-certificate-errors',
    '--ignore-certificate-errors-spki-list',
    '--disable-web-security',
    '--disable-features=VizDisplayCompositor',
    '--disable-extensions',
    '--disable-plugins',
    '--disable-images'
  ],
  defaultViewport: { width: 1280, height: 800 }
};

let browserInstance = null;
let isInitialised = false;

/**
 * Initialize the nodriver browser instance
 * @returns {Promise<Object>} Browser instance and connection info
 */
export async function initNodriverBrowser({ headless = false, requireConnected = false } = {}) {
  if (isInitialised && browserInstance) {
    return { browser: browserInstance, connected: true };
  }

  try {
    // Check if we can connect to an existing Chrome instance first
    const existingBrowser = await getExistingBrowser();
    if (existingBrowser) {
      browserInstance = existingBrowser.browser;
      isInitialised = true;
      return { browser: browserInstance, connected: true };
    }
    
    // Launch new browser instance
    const browser = await createBrowser({
      ...BROWSER_CONFIG,
      headless: headless,
      autoClose: false
    });
    
    browserInstance = browser;
    isInitialised = true;
    
    return { browser, connected: false };
  } catch (error) {
    console.error('Failed to initialize nodriver browser:', error);
    throw error;
  }
}

/**
 * Get existing browser connection if available
 * @returns {Promise<Object|null>} Browser instance or null
 */
async function getExistingBrowser() {
  try {
    // Try connecting to existing Chrome at default remote debugging port
    const res = await fetch('http://localhost:9222/json/version', {
      signal: AbortSignal.timeout(1500),
    });
    
    if (res.ok) {
      const { webSocketDebuggerUrl } = await res.json();
      if (webSocketDebuggerUrl) {
        // We should be able to connect, but nodriver might require a different approach
        return null; // For now, we'll create a fresh instance
      }
    }
  } catch (error) {
    // No existing browser running
    return null;
  }
  
  return null;
}

/**
 * Create a new page with enhanced settings to avoid detection
 * @param {Object} browser - Nodriver browser instance
 * @returns {Promise<Object>} Page object and information
 */
export async function createEnhancedPage(browser) {
  try {
    const page = await browser.newPage();
    
    // Set custom user agent to look like a regular browser
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    );
    
    // Set proper viewport
    await page.setViewport({ width: 1280, height: 800 });
    
    // Disable various detection techniques
    await page.evaluateOnNewDocument(() => {
      // Override navigator properties to avoid detection
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
      
      // Remove webdriver properties from window object
      delete window.__selenium_async_script;
      delete window.__webdriver_evaluate;
    });
    
    return { page, isReusable: false };
  } catch (error) {
    console.error('Failed to create enhanced page:', error);
    throw error;
  }
}

/**
 * Enhanced page navigation with CAPTCHA detection and solving
 * @param {Object} page - Nodriver page object
 * @param {string} url - URL to navigate to
 * @returns {Promise<boolean>} Success status
 */
export async function navigateWithCaptchaHandling(page, url) {
  try {
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    
    // Detect CAPTCHA after navigation 
    const captchaDetected = await detectCaptcha(page);
    if (captchaDetected) {
      console.log('🔍 CAPTCHA detected on navigation - attempting to solve');
      
      // Try various CAPTCHA solving methods:
      const solution = await captchaSolver.handleCaptcha(page, 'image');
      
      if (solution) {
        // Submit the solved CAPTCHA
        const submitted = await captchaSolver.submitSolution(page, solution);
        if (submitted) {
          console.log('✅ CAPTCHA solved and submitted successfully');
          return true;
        } else {
          console.log('⚠ Could not submit CAPTCHA solution - continuing with form filling');
        }
      } else {
        console.log('⚠ Unable to solve CAPTCHA automatically - continuing with limited functionality');
      }
    }
    
    return true;
  } catch (error) {
    console.error('Navigation with CAPTCHA handling failed:', error);
    return false;
  }
}

/**
 * Detect if a CAPTCHA is present on the current page
 * @param {Object} page - Nodriver page object
 * @returns {Promise<boolean>} Whether CAPTCHA is detected
 */
async function detectCaptcha(page) {
  try {
    const captchaSelectors = [
      'iframe[src*="captcha"]',
      'img[src*="captcha"]',
      '[class*="captcha"]',
      'div[aria-label*="captcha"]',
      '[alt*="captcha"]',
      '.g-recaptcha',
      '#recaptcha'
    ];
    
    // Check for CAPTCHA elements in multiple ways
    for (const selector of captchaSelectors) {
      try {
        const element = await page.$(selector);
        if (element) return true;
      } catch (error) {
        // Element not found is OK
        continue;
      }
    }
    
    // Check HTML content for CAPTCHA indicators
    const htmlContent = await page.content();
    const captchaIndicators = [
      'recaptcha',
      'hcaptcha', 
      'cf-turnstile',
      'captcha'
    ];
    
    return captchaIndicators.some(indicator => 
      htmlContent.toLowerCase().includes(indicator)
    );
    
  } catch (error) {
    console.warn('CAPTCHA detection failed:', error);
    return false;
  }
}

/**
 * Close the browser instance
 */
export async function closeBrowser() {
  if (browserInstance && isInitialised) {
    try {
      await browserInstance.close();
      browserInstance = null;
      isInitialised = false;
    } catch (error) {
      console.error('Error closing browser:', error);
    }
  }
}

/**
 * Get the current browser instance
 * @returns {Object|null} Browser instance or null
 */
export function getBrowserInstance() {
  return browserInstance;
}