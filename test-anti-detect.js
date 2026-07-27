// Test script for anti-detection browser functionality

import { createAntiDetectBrowser } from './src/lib/anti-detect-browser.js';

async function testAntiDetect() {
  console.log('Testing anti-detection browser implementation...');
  
  try {
    // Try to create an enhanced browser
    const result = await createAntiDetectBrowser({ headless: true });
    console.log('✅ Successfully created anti-detection browser');
    console.log('Browser type:', result.type);
    
    if (result.browser) {
      const page = await result.browser.newPage();
      await page.goto('https://httpbin.org/user-agent');
      
      const userAgent = await page.evaluate(() => navigator.userAgent);
      console.log('User agent set to:', userAgent);
      
      await result.browser.close();
      console.log('✅ Browser test completed successfully');
    } else {
      console.log('⚠ No browser created, might be fallback');
    }
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
  }
}

// Run the test
testAntiDetect();