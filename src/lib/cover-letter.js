// Fixed outreach email template — the exact letter Pulkit approved, with only
// the company name swapped in per recipient. No AI rewriting per company, so
// every email is identical except the company name.
//
// Returns { text, html }:
//   - text: clean plain-text version (bulleted with •, no bold) — the fallback
//     for clients that prefer plain text, and what's stored/shown in the UI.
//   - html: same letter with company names and key role/skill terms bolded so a
//     recruiter's eye catches them when skimming.
import { PROFILE } from './profile.js';

const SENDER_EMAIL = process.env.SMTP_EMAIL || 'pulkitagarwal2020@gmail.com';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function generateCoverLetter(companyName) {
  const company = (companyName || '').trim();
  const atCompany = company ? ` at ${company}` : '';
  const atCompanyHtml = company ? ` at <strong>${escapeHtml(company)}</strong>` : '';

  const text = `Hi,

I hope you're doing well.

I'm ${PROFILE.name}, a Software Engineer at Magna International with hands-on experience building production-grade backend systems, microservices, agentic AI applications, and modern web platforms.

At Magna, I build and maintain GoLang backend services within a microservices architecture for autonomous mobile robot (AMR) systems, and independently delivered an enterprise-grade RBAC via OIDC authentication system with a Vue.js frontend. Previously, I worked as a Full-Stack Developer at Cadera Infotech, where I built the Study Abroad platform using React.js, Node.js, Express.js, MongoDB, and AI-powered automation workflows. I also worked with a US startup, Foundry Digital, developing cloud-based services on AWS and contributing to production .NET/TypeScript applications.

My core expertise includes:
• GoLang, Node.js, Express.js
• React.js, Next.js, Vue.js
• Microservices, Docker, Kubernetes
• MongoDB, PostgreSQL, Redis
• AWS Cloud
• Agentic AI, LLM integrations, and workflow automation

I'm currently exploring Software Engineer, Backend Engineer, Full-Stack Engineer, or AI Engineer opportunities${atCompany} where I can contribute to building scalable products.

I've attached my resume for your review. If there's a suitable opening, I'd greatly appreciate the opportunity to discuss how I can contribute to your team.

Thank you for your time, and I look forward to hearing from you.

Best regards,

${PROFILE.name}
Software Engineer | Full-Stack & AI Engineer
📧 ${SENDER_EMAIL}
📱 ${PROFILE.phone}`;

  const html = `Hi,<br><br>
I hope you're doing well.<br><br>
I'm ${escapeHtml(PROFILE.name)}, a Software Engineer at <strong>Magna International</strong> with hands-on experience building production-grade backend systems, microservices, agentic AI applications, and modern web platforms.<br><br>
At <strong>Magna</strong>, I build and maintain GoLang backend services within a microservices architecture for autonomous mobile robot (AMR) systems, and independently delivered an enterprise-grade RBAC via OIDC authentication system with a Vue.js frontend. Previously, I worked as a Full-Stack Developer at <strong>Cadera Infotech</strong>, where I built the Study Abroad platform using React.js, Node.js, Express.js, MongoDB, and AI-powered automation workflows. I also worked with a US startup, <strong>Foundry Digital</strong>, developing cloud-based services on AWS and contributing to production .NET/TypeScript applications.<br><br>
My core expertise includes:
<ul style="margin:8px 0 14px 0; padding-left:22px;">
<li>GoLang, Node.js, Express.js</li>
<li>React.js, Next.js, Vue.js</li>
<li>Microservices, Docker, Kubernetes</li>
<li>MongoDB, PostgreSQL, Redis</li>
<li>AWS Cloud</li>
<li>Agentic AI, LLM integrations, and workflow automation</li>
</ul>
I'm currently exploring <strong>Software Engineer</strong>, <strong>Backend Engineer</strong>, <strong>Full-Stack Engineer</strong>, or <strong>AI Engineer</strong> opportunities${atCompanyHtml} where I can contribute to building scalable products.<br><br>
I've attached my resume for your review. If there's a suitable opening, I'd greatly appreciate the opportunity to discuss how I can contribute to your team.<br><br>
Thank you for your time, and I look forward to hearing from you.<br><br>
Best regards,<br><br>
${escapeHtml(PROFILE.name)}<br>
Software Engineer | Full-Stack &amp; AI Engineer<br>
📧 ${escapeHtml(SENDER_EMAIL)}<br>
📱 ${escapeHtml(PROFILE.phone)}`;

  return { text, html };
}
