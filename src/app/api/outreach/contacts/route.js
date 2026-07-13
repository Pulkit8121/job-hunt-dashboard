export const dynamic = 'force-dynamic';

import { readOutreachContacts, deleteOutreachContact, updateOutreachContact } from '@/lib/db';

export async function GET() {
  const contacts = await readOutreachContacts();
  return Response.json(contacts);
}

export async function DELETE(request) {
  const { email } = await request.json().catch(() => ({}));
  if (!email) return Response.json({ error: 'email required' }, { status: 400 });
  await deleteOutreachContact(email);
  return Response.json({ ok: true });
}

export async function PATCH(request) {
  const { email, status } = await request.json().catch(() => ({}));
  if (!email || !status) return Response.json({ error: 'email and status required' }, { status: 400 });
  await updateOutreachContact(email, { status });
  return Response.json({ ok: true });
}
