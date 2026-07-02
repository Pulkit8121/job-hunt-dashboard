export const dynamic = 'force-dynamic';
import { readApplied } from '@/lib/db';

export async function GET() {
  const applied = await readApplied();
  return Response.json(applied);
}
