import { TwoCaptcha } from '@2captcha/2captcha-api';
import * as dotenv from 'dotenv';

dotenv.config();

const CAPTCHA_API_KEY = process.env.CAPTCHA_API_KEY;

async function solveCaptcha(page) {
  const captchaSolver = new TwoCaptcha(CAPTCHA_API_KEY);

  // Wait for the captcha to appear
  await page.waitForSelector('#captcha-image', { timeout: 10000 });

  // Get the captcha image URL
  const captchaImage = await page.$eval('#captcha-image', img => img.src);
  const response = await fetch(captchaImage);
  const buffer = await response.arrayBuffer();

  // Solve the captcha
  const result = await captchaSolver.solve(buffer, {
    type: 'image',
  });

  return result.text;
}

async function tryGraphQLApply(page, job, onProgress) {
  const jobListingId = await extractJobListingId(page);
  if (!jobListingId) return { attempted: false };

  const modalData = await fetchJobApplicationModal(page, jobListingId);
  if (!modalData) return { attempted: false };

  const jobListing = modalData.jobListing || modalData.talent?.jobListing || null;
  if (!jobListing) return { attempted: false };

  // Solve the captcha
  const captchaSolution = await solveCaptcha(page);

  // Proceed with the application process using the captcha solution
  // ...
}
