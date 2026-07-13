export const dynamic = 'force-dynamic';

import { generateCoverLetter } from '@/lib/cover-letter';
import { sendOutreachEmail } from '@/lib/mailer';

export async function POST(request) {
  const { companyName = 'Example Company' } = await request.json().catch(() => ({}));

  try {
    const coverLetter = await generateCoverLetter(companyName);
    const to = process.env.SMTP_EMAIL;
    await sendOutreachEmail({
      to,
      subject: `[TEST] Full-Stack AI Engineer — application (${companyName})`,
      text: coverLetter,
    });
    return Response.json({ ok: true, to, coverLetter });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
