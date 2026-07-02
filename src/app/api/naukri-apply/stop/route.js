export const dynamic = 'force-dynamic';

import { stopRun, isRunning } from '@/lib/naukriRunState';

export async function POST() {
  const wasRunning = isRunning();
  const stopped = stopRun();
  return Response.json({ stopped, wasRunning });
}

export async function GET() {
  return Response.json({ running: isRunning() });
}
