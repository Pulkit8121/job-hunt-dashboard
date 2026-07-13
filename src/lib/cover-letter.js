// Fixed outreach email template — the exact letter Pulkit approved, with only
// the company name swapped in per recipient. No AI rewriting per company, so
// every email is identical except the company name (no per-send variance, no
// filler creeping in). The `companyName` is inserted into the "exploring
// opportunities at ___" line.
import { PROFILE } from './profile.js';

const SENDER_EMAIL = process.env.SMTP_EMAIL || 'pulkitagarwal2020@gmail.com';

export async function generateCoverLetter(companyName) {
  const company = (companyName || '').trim();
  const atCompany = company ? ` at ${company}` : '';

  return `Hi,

I hope you're doing well.

I'm ${PROFILE.name}, a Software Engineer at Magna International with hands-on experience building production-grade backend systems, microservices, AI-powered applications, and modern web platforms.

At Magna, I develop GoLang microservices for autonomous mobile robot (AMR) systems and independently delivered an enterprise-grade RBAC via OIDC authentication system with a Vue.js frontend. Previously, I worked as a Full-Stack Developer at Cadera Infotech, where I built the Study Abroad platform using React.js, Node.js, Express.js, MongoDB, and AI-powered automation workflows. I also worked with a US startup, Foundry Digital, developing cloud-based services on AWS and contributing to production .NET/TypeScript applications.

My core expertise includes:
• GoLang, Node.js, Express.js
• React.js, Next.js, Vue.js
• Microservices, Docker, Kubernetes
• MongoDB, PostgreSQL, Redis
• AWS Cloud
• AI/LLM integrations and workflow automation

I'm currently exploring Software Engineer, Backend Engineer, Full-Stack Engineer, or AI Engineer opportunities${atCompany} where I can contribute to building scalable products.

I've attached my resume for your review. If there's a suitable opening, I'd greatly appreciate the opportunity to discuss how I can contribute to your team.

Thank you for your time, and I look forward to hearing from you.

Best regards,

${PROFILE.name}
Software Engineer | Full-Stack & AI Engineer
📧 ${SENDER_EMAIL}
📱 ${PROFILE.phone}`;
}
