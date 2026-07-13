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

// Gmail renders plain-text-only emails in a small default font. We send an HTML
// version wrapped in one consistent, readable font/size so it's legible instead
// of tiny. If a pre-built html fragment (with intentional bold) is passed we use
// it; otherwise we derive a plain, unstyled HTML from the text. Either way the
// raw `text` is still sent alongside as the fallback for plain-text clients.
function wrapHtml(htmlFragment) {
  return `<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.6; color: #202124;">${htmlFragment}</div>`;
}

function textToHtml(text) {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  return wrapHtml(escaped);
}

export async function sendOutreachEmail({ to, subject, text, html }) {
  const resumePath = path.resolve(process.cwd(), process.env.RESUME_PATH || './data/resume.pdf');
  const t = await getTransporter();
  return t.sendMail({
    from: `"${process.env.SMTP_FROM_NAME || 'Pulkit Agarwal'}" <${process.env.SMTP_EMAIL}>`,
    to,
    subject,
    text,
    html: html ? wrapHtml(html) : textToHtml(text),
    attachments: [{ filename: 'Pulkit_Agarwal_Resume.pdf', path: resumePath }],
  });
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
