// Enhanced browser automation with anti-detection techniques
// This module provides tools to make Puppeteer and nodriver more effective against bot detection

import { createBrowser } from 'nodriver';
import { getBrowser as getNodriverBrowser } from './nodriver-browser.js';

// Default configuration for anti-detection
const DEFAULT_ANTIDETECT_CONFIG = {
  // Browser launch arguments to avoid detection
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
    '--disable-images',
    '--disable-webgl',
    '--disable-gpu',
    '--disable-3d-apis',
    '--disable-java',
    '--disable-webrtc'
  ],
  
  // Browser viewport size
  defaultViewport: { 
    width: 1280, 
    height: 800 
  },
  
  // User agent to appear more human-like
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
};

/**
 * Enhanced browser factory that applies anti-detection techniques
 * @param {Object} options - Browser launch options
 * @returns {Promise<Object>} Enhanced browser instance
 */
export async function createAntiDetectBrowser(options = {}) {
  const config = {
    ...DEFAULT_ANTIDETECT_CONFIG,
    ...options
  };

  try {
    // Try to use nodriver first as it's more robust for CAPTCHA handling
    const nodriverResult = await getNodriverBrowser({ headless: config.headless });
    if (nodriverResult.browser) {
      return { browser: nodriverResult.browser, type: 'nodriver' };
    }
  } catch (error) {
    console.warn('Nodriver initialization failed, falling back to Puppeteer:', error.message);
  }

  // Fall back to enhanced Puppeteer
  try {
    const puppeteer = (await import('puppeteer')).default;
    
    // Apply stealth techniques to Puppeteer
    const puppeteerExtra = (await import('puppeteer-extra')).default;
    const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
    
    puppeteerExtra.use(StealthPlugin());
    
    const browser = await puppeteerExtra.launch({
      ...config,
      headless: config.headless,
      args: config.args
    });
    
    return { browser, type: 'puppeteer' };
  } catch (error) {
    console.error('Failed to initialize enhanced Puppeteer browser:', error);
    
    // Final fallback - use regular Puppeteer with basic configuration
    const puppeteer = (await import('puppeteer')).default;
    const browser = await puppeteer.launch({
      headless: config.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--window-size=1280,800'
      ],
      defaultViewport: { width: 1280, height: 800 },
    });
    
    return { browser, type: 'puppeteer-basic' };
  }
}

/**
 * Apply anti-detection techniques to an existing browser page
 * @param {Object} page - Browser page object
 * @returns {Promise<void>}
 */
export async function applyAntiDetect(page) {
  try {
    // Set user agent
    await page.setUserAgent(DEFAULT_ANTIDETECT_CONFIG.userAgent);
    
    // Set viewport
    await page.setViewport(DEFAULT_ANTIDETECT_CONFIG.defaultViewport);
    
    // Remove webdriver properties that are often flagged
    await page.evaluateOnNewDocument(() => {
      // Overwrite navigator.webdriver to prevent detection
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
      
      // Remove common bot detection markers  
      delete window.__selenium_async_script;
      delete window.__webdriver_evaluate;
      delete window.__driver_evaluate;
    });
    
    // Randomize user agent if needed (can help with detection)
    await randomizePageBehavior(page);
  } catch (error) {
    console.warn('Failed to apply anti-detection techniques:', error.message);
  }
}

/**
 * Apply randomization to page behavior to avoid bot detection
 * @param {Object} page - Browser page object
 */
async function randomizePageBehavior(page) {
  try {
    // Add random delays to simulate human-like behavior
    await new Promise(resolve => setTimeout(resolve, Math.random() * 3000 + 1000));
    
    // Simulate random mouse movement (helps avoid detection)
    const { width, height } = DEFAULT_ANTIDETECT_CONFIG.defaultViewport;
    await page.mouse.move(
      Math.floor(Math.random() * width),
      Math.floor(Math.random() * height)
    );
    
    // Add subtle scrolling behavior
    await page.evaluate(() => {
      window.scrollBy(0, Math.floor(Math.random() * 100) + 50);
    });
  } catch (error) {
    // Ignore errors in behavior randomization - it's just for anti-detection
  }
}

/**
 * Enhanced page creation with anti-detection measures
 * @param {Object} browser - Browser instance
 * @returns {Promise<Object>} Page with anti-detection enabled
 */
export async function createEnhancedPage(browser) {
  try {
    const page = await browser.newPage();
    await applyAntiDetect(page);
    return page;
  } catch (error) {
    console.error('Failed to create enhanced page:', error);
    // Fallback - create regular page
    const page = await browser.newPage();
    return page;
  }
}

export { createEnhancedPage };