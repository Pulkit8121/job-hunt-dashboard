// Enhanced browser automation with basic anti-detection techniques
// This module provides tools to make browser automation less detectable

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
 * Apply anti-detection techniques to a Puppeteer page
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
      
      // Additional anti-detection techniques
      delete window.chrome;
      
      // Override window.navigator.plugins to hide plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [],
      });
    });
  } catch (error) {
    console.warn('Failed to apply anti-detection techniques:', error.message);
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