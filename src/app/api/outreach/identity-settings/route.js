export const dynamic = 'force-dynamic';

import { listIdentities } from '@/lib/identities';
import { readIdentitySettings, updateIdentitySettings } from '@/lib/db';

const DEFAULTS = { dailyLimit: 150, autoSendEnabled: true };

// Returns every configured identity merged with its stored settings (or the
// defaults, if it's never been touched from the dashboard).
export async function GET() {
  const identities = listIdentities();
  const stored = await readIdentitySettings();
  const byId = Object.fromEntries(stored.map(s => [s.identityId, s]));

  return Response.json(identities.map(i => ({
    ...i,
    dailyLimit: byId[i.id]?.dailyLimit ?? DEFAULTS.dailyLimit,
    autoSendEnabled: byId[i.id]?.autoSendEnabled ?? DEFAULTS.autoSendEnabled,
  })));
}

export async function POST(request) {
  const { identityId, dailyLimit, autoSendEnabled } = await request.json().catch(() => ({}));
  if (!identityId) {
    return Response.json({ error: 'identityId is required' }, { status: 400 });
  }

  const update = {};
  if (dailyLimit !== undefined) {
    const n = Number(dailyLimit);
    if (!Number.isFinite(n) || n < 0) {
      return Response.json({ error: 'dailyLimit must be a non-negative number' }, { status: 400 });
    }
    update.dailyLimit = Math.floor(n);
  }
  if (autoSendEnabled !== undefined) {
    update.autoSendEnabled = !!autoSendEnabled;
  }

  const saved = await updateIdentitySettings(identityId, update);
  return Response.json({ success: true, settings: saved });
}
