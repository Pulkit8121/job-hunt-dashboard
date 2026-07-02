export const dynamic = 'force-dynamic';
import { readPeople } from '@/lib/db';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const companyId = searchParams.get('companyId') || undefined;
  const people = await readPeople(companyId);
  return Response.json(people);
}
