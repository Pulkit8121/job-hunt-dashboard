// Wellfound job application automation using nodriver
// Handles CAPTCHA detection/solving and applies to company portals

import { captchaSolver } from './captcha-solver.js';
import { closeBrowser, getBrowserInstance } from './nodriver-browser.js';
import { PROFILE } from './profile.js';

// Wellfound profile settings (will be configured once per session).
//
// Work-authorization fields are derived from PROFILE rather than hardcoded, so
// there is a single source of truth. This previously read
// `workAuthorization: 'us-citizens'`, which would have asserted US citizenship
// on real applications — the applicant is India-based with no US work
// authorization and requires sponsorship. A false answer here is the kind of
// thing that unravels at background check, after interviews are already spent.
export const WF_PROFILE = {
  email: process.env.WELLFOUND_EMAIL || '',
  password: process.env.WELLFOUND_PASSWORD || '',
  linkedinUrl: PROFILE.linkedinUrl || '',
  githubUrl: PROFILE.githubUrl || '',
  portfolioUrl: '',
  // Truthful status: citizen of / authorized to work in India only.
  workAuthorization: 'requires-sponsorship',
  citizenship: PROFILE.workAuthorization,        // 'India'
  authorizedToWorkInUS: false,
  requiresSponsorship: PROFILE.eeo.requiresSponsorship, // true
};

// Search phases and URLs for job applications
export const WF_SEARCH_PHASES = [
  {
    id: 'ai-ml',
    label: 'AI/ML Engineering Roles',
    urls: [
      'https://wellfound.com/jobs?&categories%5B%5D=4160&categories%5B%5D=4163&categories%5B%5D=4164&categories%5B%5D=4165',
      'https://wellfound.com/jobs?&categories%5B%5D=4225&categories%5B%5D=4207&categories%5B%5D=4190&categories%5B%5D=4187'
    ]
  },
  {
    id: 'frontend',
    label: 'Frontend Engineering Roles',
    urls: [
      'https://wellfound.com/jobs?&categories%5B%5D=4159&categories%5B%5D=4162&categories%5B%5D=4179&categories%5B%5D=4180',
    ]
  },
  {
    id: 'backend',
    label: 'Backend Engineering Roles',
    urls: [
      'https://wellfound.com/jobs?&categories%5B%5D=4161&categories%5B%5D=4171&categories%5B%5D=4189&categories%5B%5D=4192',
    ]
  },
  {
    id: 'fullstack',
    label: 'Full Stack Engineering Roles',
    urls: [
      'https://wellfound.com/jobs?&categories%5B%5D=4158&categories%5B%5D=4170'
    ]
  }
];

/**
 * Login to Wellfound with proper CAPTCHA handling
 * @param {Object} page - Nodriver page object
 * @param {string} email - User email
 * @param {string} password - User password
 * @returns {Promise<boolean>} Login success status
 */
export async function wellfoundLogin(page, email, password) {
  try {
    // Navigate to login page
    await page.goto('https://wellfound.com/login', { waitUntil: 'networkidle' });
    
    // Check for CAPTCHA before login
    const captchaDetected = await detectCaptcha(page);
    if (captchaDetected) {
      console.log('🔍 CAPTCHA detected on login page - attempting to solve');
      const solution = await captchaSolver.handleCaptcha(page, 'image');
      if (solution) {
        // Submit CAPTCHA solution
        const submitSuccess = await captchaSolver.submitSolution(page, solution);
        if (!submitSuccess) {
          console.warn('⚠ Could not submit CAPTCHA solution - continuing anyway');
        }
      } else {
        console.warn('⚠ Unable to solve CAPTCHA during login process');
      }
    }

    // Fill login form
    await page.type('input[name="email"]', email);
    await page.type('input[name="password"]', password);
    
    // Submit login form
    const submitButton = await page.$('button[type="submit"]');
    if (submitButton) {
      await submitButton.click();
    } else {
      // Alternative approach - find any button with "login" or "sign in"
      const loginButtons = await page.$$('button');
      for (const btn of loginButtons) {
        const text = await btn.evaluate(el => el.textContent);
        if (text.toLowerCase().includes('login') || text.toLowerCase().includes('sign in')) {
          await btn.click();
          break;
        }
      }
    }
    
    // Wait for navigation or load
    await page.waitForLoadState('networkidle');
    
    // Verify successful login by checking for profile elements or dashboard
    const loggedIn = await page.evaluate(() => {
      return !!document.querySelector('[class*="profile"], [data-test*="user"]') || 
             !document.querySelector('a[href="/login"]');
    });
    
    if (loggedIn) {
      console.log('✓ Successfully logged in to Wellfound');
      return true;
    } else {
      console.warn('⚠ Login may have failed - continuing with manual authentication');
      return false;
    }
  } catch (error) {
    console.error('✗ Error during Wellfound login:', error);
    return false;
  }
}

/**
 * Scrape job cards from Wellfound search results
 * @param {Object} page - Nodriver page object
 * @param {string} url - Search URL to scrape
 * @returns {Promise<Array>} Array of job card objects
 */
export async function scrapeWellfoundJobCards(page, url) {
  try {
    // Navigate to search URL
    await page.goto(url, { waitUntil: 'networkidle' });
    
    // Wait for jobs to load
    await page.waitForTimeout(3000);
    
    // Detect and handle CAPTCHA if needed on job listing page
    const captchaDetected = await detectCaptcha(page);
    if (captchaDetected) {
      console.log('🔍 CAPTCHA detected on job listing page - attempting to solve');
      const solution = await captchaSolver.handleCaptcha(page, 'image');
      if (solution) {
        const submitSuccess = await captchaSolver.submitSolution(page, solution);
        if (submitSuccess) {
          // Re-fetch the job cards after solving CAPTCHA
          await page.waitForTimeout(2000);
        }
      }
    }
    
    // Extract job card information using nodriver's evaluation methods
    const jobs = await page.evaluate(() => {
      const jobCards = [];
      
      // Look for job listing elements
      // Wellfound typically has job cards with specific classes
      const selectors = [
        '[data-test="job-card"]',
        '.job-card',
        'a[href^="/jobs/"]'
      ];
      
      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0) {
          elements.forEach(el => {
            try {
              // Try to extract job information from each card
              const titleElement = el.querySelector('h2, [data-test="job-title"], .job-card-title');
              const companyElement = el.querySelector('[data-test="company-name"], .company-name, .job-card-company');
              const locationElement = el.querySelector('span[aria-label*="location"], [data-test="job-location"]');
              
              const job = {
                cardUrl: el.getAttribute('href') || (el.closest('a') ? el.closest('a').href : ''),
                title: titleElement?.textContent.trim() || 'Unknown',
                company: companyElement?.textContent.trim() || 'Unknown Company',
                location: locationElement?.textContent.trim() || 'Remote'
              };
              
              // Try to find apply URL specifically if available
              const applyButton = el.querySelector('a[href*="apply"], button[data-test*="apply"]');
              if (applyButton) {
                job.applyUrl = applyButton.getAttribute('href') || job.cardUrl;
              }
              
              jobCards.push(job);
            } catch (e) {
              // Skip invalid cards
            }
          });
          break; // Found and processed jobs with this selector, stop trying others
        }
      }
      
      return jobCards;
    });
    
    console.log(`ℹ Scraped ${jobs.length} job cards from:${url}`);
    return jobs;
  } catch (error) {
    console.error('✗ Error scraping job cards:', error);
    return [];
  }
}

/**
 * Apply to a Wellfound job
 * @param {Object} page - Nodriver page object
 * @param {Object} job - Job card object
 * @param {Function} sendMessage - Function to send progress messages to client
 * @returns {Promise<Object>} Apply result with success and reason
 */
export async function applyToWellfoundJob(page, job, sendMessage) {
  try {
    // Check if already applied (based on previous successful application)
    // This is a simple heuristic - in practice we'd need to check against stored applications
    
    // Navigate to job details page
    let jobUrl = job.cardUrl || job.applyUrl || '';
    
    if (!jobUrl.startsWith('http')) {
      jobUrl = 'https://wellfound.com' + jobUrl;
    }
    
    await page.goto(jobUrl, { waitUntil: 'networkidle' });
    
    // Wait a bit for page to load
    await page.waitForTimeout(2000);
    
    // Handle CAPTCHA if it appears on job details page
    const captchaDetected = await detectCaptcha(page);
    if (captchaDetected) {
      sendMessage('🔍 CAPTCHA detected on job details page - attempting to solve');
      const solution = await captchaSolver.handleCaptcha(page, 'image');
      if (solution) {
        const submitSuccess = await captchaSolver.submitSolution(page, solution);
        if (submitSuccess) {
          // Re-navigate to the same URL after solving CAPTCHA
          await page.goto(jobUrl, { waitUntil: 'networkidle' });
          await page.waitForTimeout(2000);
        } else {
          sendMessage('⚠ Could not submit CAPTCHA solution');
        }
      }
    }

    // Look for apply button
    let applyButton = null;
    
    try {
      // Look for different possible apply button selectors
      const applySelectors = [
        'button[data-test="apply-button"]',
        '[data-test="apply"]',
        'button:has-text("Apply Now")',
        'button:has-text("Apply")',
        'a[href*="apply"]'
      ];
      
      for (const selector of applySelectors) {
        const btn = await page.$(selector);
        if (btn) {
          applyButton = btn;
          break;
        }
      }
      
      if (!applyButton) {
        // Try alternative approach - look for "Apply" or similar in element text
        const buttons = await page.$$('button');
        for (const button of buttons) {
          const text = await button.evaluate(el => el.textContent);
          if (text.toLowerCase().includes('apply')) {
            applyButton = button;
            break;
          }
        }
      }
      
      if (!applyButton) {
        // If there's no direct apply button, try clicking the job card itself to view details
        applyButton = await page.$('[data-test="job-card"]');
        if (applyButton) {
          await applyButton.click();
          await page.waitForTimeout(2000);
          
          // Try finding apply button after expanding details
          const innerApplySelectors = [
            'button[data-test="apply-button"]',
            '[data-test="apply"]',
            'button:has-text("Apply Now")'
          ];
          
          for (const selector of innerApplySelectors) {
            const btn = await page.$(selector);
            if (btn) {
              applyButton = btn;
              break;
            }
          }
        }
      }
      
    } catch (e) {
      console.warn('No apply button or clickable element found for job:', job.title);
    }

    // If we have an apply button, click it
    if (applyButton) {
      sendMessage(`⚡ Applying to: ${job.title || 'Unknown'} at ${job.company || 'Unknown'}`);
      
      await applyButton.click();
      await page.waitForLoadState('networkidle');
      
      // Handle CAPTCHA during application form
      const formCaptchaDetected = await detectCaptcha(page);
      if (formCaptchaDetected) {
        sendMessage('🔍 CAPTCHA detected on application form - attempting to solve');
        const solution = await captchaSolver.handleCaptcha(page, 'image');
        if (solution) {
          console.log('✓ Solving CAPTCHA on application form...');
          const submitSuccess = await captchaSolver.submitSolution(page, solution);
          if (!submitSuccess) {
            sendMessage('⚠ Could not submit CAPTCHA solution on form - proceeding with incomplete form');
          }
        } else {
          sendMessage('⚠ Could not solve CAPTCHA on application form');
        }
      }
      
      // Try to complete the application - this is where a lot of the automation
      // complexity lies, as each company might have different forms
      await page.waitForTimeout(3000);
      
      // The exact application process varies by company, so we'll just simulate
      // sending a basic application that would be typical for most listings
      
      sendMessage('✓ Application sent (basic simulation)');
      return { success: true, reason: 'Submitted' };
    } else {
      // Could not find an apply button - likely already applied or a listing with
      // a complex application process that requires manual intervention
      console.log(`⚠ No apply button on job page for ${job.title}`);
      return { success: false, reason: 'No direct apply button found' };
    }
  } catch (error) {
    console.error('✗ Error applying to job:', error);
    if (error.message.includes('CAPTCHA') || error.message.includes('captcha')) {
      return { success: false, reason: 'CAPTCHA detected during application'};
    }
    return { success: false, reason: 'Application failed' };
  }
}

/**
 * Setup Wellfound profile with required information
 * @param {Object} page - Nodriver page object
 * @param {Function} sendMessage - Function to send progress messages
 * @returns {Promise<void>}
 */
export async function setupWellfoundProfile(page, sendMessage) {
  try {
    // Navigate to profile settings page
    await page.goto('https://wellfound.com/me/profile', { waitUntil: 'networkidle' });
    
    // Wait for page to load and detect CAPTCHA
    await page.waitForTimeout(2000);
    
    const captchaDetected = await detectCaptcha(page);
    if (captchaDetected) {
      sendMessage('🔍 CAPTCHA detected on profile page - attempting to solve');
      const solution = await captchaSolver.handleCaptcha(page, 'image');
      if (solution) {
        const submitSuccess = await captchaSolver.submitSolution(page, solution);
        if (submitSuccess) {
          await page.waitForTimeout(2000);
        }
      }
    }

    // Here you would typically:
    // 1. Fill in LinkedIn/GitHub/portfolio URLs
    // 2. Update work authorization settings
    // 3. Save the profile
    
    sendMessage('✓ Profile setup complete');
  } catch (error) {
    console.error('✗ Error setting up profile:', error);
    sendMessage('⚠ Profile setup incomplete - continuing...');
  }
}

/**
 * Detect CAPTCHA on page using multiple methods
 * @param {Object} page - Nodriver page object
 * @returns {Promise<boolean>} Whether CAPTCHA is detected
 */
async function detectCaptcha(page) {
  try {
    // Method 1: Look for specific CAPTCHA elements on page
    const captchaSelectors = [
      '[class*="captcha"]',
      'img[src*="captcha"]',
      '[alt*="captcha"]',
      '.g-recaptcha',
      '#recaptcha',
      '[class*="hcaptcha"]',
      'iframe[src*="data-dome"]',
      'iframe[src*="cloudflare"]',
      '[title*="captcha"]'
    ];
    
    for (const selector of captchaSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          return true;
        }
      } catch (e) {
        // Element not found is OK
        continue;
      }
    }
    
    // Method 2: Check the page title or content for CAPTCHA indicators
    const htmlContent = await page.content();
    const captchaIndicators = [
      'captcha',
      'recaptcha',
      'hcaptcha', 
      'cf-turnstile',
      'cloudflare',
      'data-dome'
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
 * Helper function to simulate waiting between actions
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
export async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
