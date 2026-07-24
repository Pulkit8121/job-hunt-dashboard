// Wellfound auto-apply is not implemented. A prior commit added an unfinished
// CAPTCHA-solving integration here (importing a package that doesn't exist
// under that name, and nothing in this file was ever exported), which broke
// the production build for the entire app. Left as a stub — src/app/api/
// wellfound-apply/route.js still imports from here and will need a real
// implementation before that route works.
