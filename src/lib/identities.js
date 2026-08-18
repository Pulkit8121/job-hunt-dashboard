// Registry of sending identities. Each identity is a fully separate Gmail
// account with its OWN app password, resume file, and signature email — never
// mix them, since the resume PDF itself has a specific email printed on it and
// sending it from the other account would look inconsistent to the recipient.
export const IDENTITIES = {
  primary: {
    id: 'primary',
    email: process.env.SMTP_EMAIL || 'pulkitagarwal2020@gmail.com',
    appPassword: process.env.SMTP_APP_PASSWORD,
    resumeFilename: 'Pulkit_Agarwal_Resume.pdf',
    resumePath: process.env.RESUME_PATH || './data/resume.pdf',
    displayName: 'Pulkit Agarwal',
    label: 'pulkitagarwal2020@gmail.com',
  },
  secondary: {
    id: 'secondary',
    email: process.env.SMTP_EMAIL_2 || 'pa.devworks@gmail.com',
    appPassword: process.env.SMTP_APP_PASSWORD_2,
    resumeFilename: 'Pulkit_Agarwal_Resume.pdf',
    resumePath: process.env.RESUME_PATH_2 || './data/resume-devworks.pdf',
    displayName: 'Pulkit Agarwal',
    label: 'pa.devworks@gmail.com',
  },
};

export function getIdentity(id) {
  return IDENTITIES[id] && IDENTITIES[id].appPassword ? IDENTITIES[id] : IDENTITIES.primary;
}

export function isIdentityConfigured(id) {
  const identity = IDENTITIES[id];
  return !!(identity && identity.email && identity.appPassword);
}

export function listIdentities() {
  return Object.values(IDENTITIES).map(i => ({
    id: i.id,
    email: i.email,
    label: i.label,
    configured: isIdentityConfigured(i.id),
  }));
}

// Full identity objects (including appPassword) for every identity that's
// actually configured — for code that needs to open an IMAP/SMTP connection
// per mailbox (reply/bounce checking, inbox scanning), not just display info.
export function getConfiguredIdentities() {
  return Object.values(IDENTITIES).filter(i => isIdentityConfigured(i.id));
}
