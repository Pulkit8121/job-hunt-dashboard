export const dynamic = 'force-dynamic';

import { readMailInsights } from '@/lib/db';

export async function GET() {
  const insights = await readMailInsights();
  return Response.json(insights);
}
