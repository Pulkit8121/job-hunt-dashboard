import path from 'path';

let transporter = null;

async function getTransporter() {
  if (transporter) return transporter;
  const nodemailer = (await import('nodemailer')).default;
  transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.SMTP_EMAIL,
      pass: process.env.SMTP_APP_PASSWORD,
    },
  });
  return transporter;
}

export async function sendOutreachEmail({ to, subject, text }) {
  const resumePath = path.resolve(process.cwd(), process.env.RESUME_PATH || './data/resume.pdf');
  const t = await getTransporter();
  return t.sendMail({
    from: `"${process.env.SMTP_FROM_NAME || 'Pulkit Agarwal'}" <${process.env.SMTP_EMAIL}>`,
    to,
    subject,
    text,
    attachments: [{ filename: 'Pulkit_Agarwal_Resume.pdf', path: resumePath }],
  });
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
