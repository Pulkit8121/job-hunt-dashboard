/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // puppeteer-extra-plugin-stealth pulls in clone-deep/merge-deep, which use
    // dynamic require() that webpack can't statically analyze — breaks the
    // production build entirely if bundled. These only ever run server-side
    // (API routes), so excluding them from the webpack bundle is correct, not
    // just a workaround.
    serverComponentsExternalPackages: ['puppeteer', 'puppeteer-extra', 'puppeteer-extra-plugin-stealth'],
  },
};

export default nextConfig;
