// Fixed templates (not AI-generated, same reasoning as cover-letter.js — a
// short auto-sent reply to a real recruiter is not the place to risk an LLM
// hallucination) for the two follow-up triggers reply-checker.js detects:
// a location-based objection, and a plain "no open roles right now" rejection.
// Both are sent as actual threaded replies (see mailer.js's inReplyTo), so the
// subject should match the thread being replied to, not restate a fresh one.
import { PROFILE } from './profile.js';
import { getIdentity } from './identities.js';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function replySubject(replySubjectLine, companyName) {
  const base = replySubjectLine || `Full-Stack AI Engineer — application for ${companyName || 'your team'}`;
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

function signOff(identityId) {
  const SENDER_EMAIL = getIdentity(identityId).email;
  return {
    text: `${PROFILE.name}\n📧 ${SENDER_EMAIL}\n📱 ${PROFILE.phone}`,
    html: `${escapeHtml(PROFILE.name)}<br>📧 ${escapeHtml(SENDER_EMAIL)}<br>📱 ${escapeHtml(PROFILE.phone)}`,
  };
}

export function buildRelocationFollowUp(companyName, identityId = 'primary', replySubjectLine) {
  const company = (companyName || '').trim();
  const atCompany = company ? ` at ${company}` : '';
  const atCompanyHtml = company ? ` at <strong>${escapeHtml(company)}</strong>` : '';
  const sign = signOff(identityId);

  const text = `Hi,

Thanks for getting back to me${atCompany}.

I wanted to follow up on one point — I'm open to relocating internationally for the right opportunity, so if the location was the only concern, I'd still love to be considered.

Happy to discuss further whenever convenient.

Best regards,

${sign.text}`;

  const html = `Hi,<br><br>
Thanks for getting back to me${atCompanyHtml}.<br><br>
I wanted to follow up on one point — I'm open to relocating internationally for the right opportunity, so if the location was the only concern, I'd still love to be considered.<br><br>
Happy to discuss further whenever convenient.<br><br>
Best regards,<br><br>
${sign.html}`;

  return { subject: replySubject(replySubjectLine, company), text, html };
}

// For a plain "no openings right now" rejection — a professional nudge to
// stay on their radar, rather than letting the conversation just end there.
export function buildNoOpeningFollowUp(companyName, identityId = 'primary', replySubjectLine) {
  const company = (companyName || '').trim();
  const atCompany = company ? ` at ${company}` : '';
  const atCompanyHtml = company ? ` at <strong>${escapeHtml(company)}</strong>` : '';
  const sign = signOff(identityId);

  const text = `Hi,

Thanks for letting me know${atCompany} — I completely understand if there's nothing open right now.

I'd still love to stay on your radar for any future roles that might be a good fit, so please feel free to reach out whenever something comes up. I'll keep an eye out as well.

Thanks again for your time.

Best regards,

${sign.text}`;

  const html = `Hi,<br><br>
Thanks for letting me know${atCompanyHtml} — I completely understand if there's nothing open right now.<br><br>
I'd still love to stay on your radar for any future roles that might be a good fit, so please feel free to reach out whenever something comes up. I'll keep an eye out as well.<br><br>
Thanks again for your time.<br><br>
Best regards,<br><br>
${sign.html}`;

  return { subject: replySubject(replySubjectLine, company), text, html };
}
