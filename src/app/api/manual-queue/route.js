export const dynamic = 'force-dynamic';

import { readManualQueue } from '@/lib/db';

export async function GET() {
  const items = await readManualQueue();
  return Response.json(items);
}
