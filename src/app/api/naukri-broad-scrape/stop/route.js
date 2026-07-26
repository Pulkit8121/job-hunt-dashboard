export const dynamic = 'force-dynamic';

import { stopRun, isRunning } from '@/lib/naukriBroadRunState';

export async function POST() {
  const wasRunning = isRunning();
  return Response.json({ stopped: stopRun(), wasRunning });
}

export async function GET() {
  return Response.json({ running: isRunning() });
}
