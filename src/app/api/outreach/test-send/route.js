export const dynamic = 'force-dynamic';

import { generateCoverLetter } from '@/lib/cover-letter';
import { sendOutreachEmail } from '@/lib/mailer';

export async function POST(request) {
  const { companyName = 'Example Company' } = await request.json().catch(() => ({}));

  try {
    const { text, html } = await generateCoverLetter(companyName);
    const to = process.env.SMTP_EMAIL;
    await sendOutreachEmail({
      to,
      subject: `[TEST] Full-Stack AI Engineer — application (${companyName})`,
      text,
      html,
    });
    return Response.json({ ok: true, to, coverLetter: text });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
