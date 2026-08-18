export const dynamic = 'force-dynamic';

import { listIdentities } from '@/lib/identities';

export async function GET() {
  return Response.json(listIdentities());
}
