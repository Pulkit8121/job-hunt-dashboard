export const dynamic = 'force-dynamic';

import { addOutreachContact, updateOutreachContact, readOutreachContacts, getIdentitySettings } from '@/lib/db';
import { generateCoverLetter } from '@/lib/cover-letter';
import { sendOutreachEmail } from '@/lib/mailer';
import { getIdentity, isIdentityConfigured } from '@/lib/identities';
import { isExcludedOutreachDomain } from '@/lib/exclusions';
import { countSentToday, getDailyCap } from '@/lib/outreachCap';

// Single, immediate, manually-triggered send — not part of the rate-limited
// bulk queue. Used for one-off sends (a specific contact you want to send to
// right now) or retrying one bounced address by hand. Works on an existing
// contact by email, or creates one on the fly if the address isn't tracked yet.
export async function POST(request) {
  const { email, companyName, identityId = 'primary' } = await request.json().catch(() => ({}));

  if (!email || !email.includes('@')) {
    return Response.json({ error: 'A valid email address is required.' }, { status: 400 });
  }
  if (!isIdentityConfigured(identityId)) {
    return Response.json({ error: `Identity "${identityId}" has no app password configured.` }, { status: 400 });
  }
  if (isExcludedOutreachDomain(email)) {
    return Response.json({ error: 'This domain is on the excluded-outreach list (current employer / freelance client).' }, { status: 400 });
  }

  const identity = getIdentity(identityId);
  const trimmedEmail = email.trim().toLowerCase();

  try {
    const contacts = await readOutreachContacts();
    const existing = contacts.find(c => c.email.toLowerCase() === trimmedEmail);
    const resolvedCompanyName = (companyName?.trim() || existing?.companyName || 'your company').replace(/\s+/g, ' ').slice(0, 60);

    // Manual sends count against the SAME per-identity daily total as the bulk
    // queue — automatic + manual together must never cross the identity's cap,
    // regardless of which path an individual send came through.
    const settings = await getIdentitySettings(identityId);
    const dailyCap = getDailyCap(settings);
    const sentToday = countSentToday(contacts, identityId);
    if (sentToday >= dailyCap) {
      return Response.json({
        error: `${identity.label} has already sent ${sentToday}/${dailyCap} today (automatic + manual combined). Raise its daily limit in the dashboard or wait until tomorrow.`,
      }, { status: 429 });
    }

    if (!existing) {
      await addOutreachContact({
        companyName: resolvedCompanyName,
        email: trimmedEmail,
        source: 'manual',
        confidence: 'high',
      });
    }

    const { text, html } = await generateCoverLetter(resolvedCompanyName, identityId);
    await sendOutreachEmail({
      to: trimmedEmail,
      subject: `Full-Stack AI Engineer — application for ${resolvedCompanyName}`,
      text,
      html,
      identityId,
    });

    await updateOutreachContact(trimmedEmail, {
      status: 'sent',
      sentAt: new Date(),
      coverLetter: text,
      sentFromIdentity: identityId,
      companyName: resolvedCompanyName,
      failCount: 0,
    });

    return Response.json({ success: true, sentVia: identity.label, email: trimmedEmail });
  } catch (e) {
    await updateOutreachContact(trimmedEmail, { lastFailReason: (e.message || '').slice(0, 300) }).catch(() => {});
    return Response.json({ error: e.message || 'Send failed' }, { status: 500 });
  }
}
