export const dynamic = 'force-dynamic';

import { listOpenAIKeys, setActiveOpenAIKey, getActiveOpenAIKey, llmStatus } from '@/lib/llm';
import { getSystemState, setSystemState } from '@/lib/db';

const STATE_KEY = 'openaiActiveKey';

// The module-level active key lives in process memory, so it resets on every
// deploy or pm2 restart. Persisting the choice in SystemState and re-applying
// it on each request makes the dashboard setting stick across restarts, and
// keeps it consistent if the app is ever run as more than one process.
async function syncFromStore() {
  const stored = await getSystemState(STATE_KEY).catch(() => null);
  if (stored && String(stored) !== getActiveOpenAIKey()) setActiveOpenAIKey(stored);
}

export async function GET() {
  await syncFromStore();
  const status = llmStatus();
  return Response.json({
    keys: listOpenAIKeys(),
    activeKey: getActiveOpenAIKey(),
    openaiModel: status.openaiModel,
    geminiModel: status.geminiModel,
    providerOrder: status.order,
    disabled: status.disabled,
  });
}

export async function POST(request) {
  const { activeKey } = await request.json().catch(() => ({}));
  const want = String(activeKey);

  const known = listOpenAIKeys();
  const match = known.find(k => k.id === want);
  if (!match) {
    return Response.json({ error: `activeKey must be one of ${known.map(k => k.id).join(', ')}` }, { status: 400 });
  }
  if (!match.configured) {
    // Switching to a key with no value would silently disable OpenAI entirely
    // and quietly fall through to Gemini — refuse instead of degrading.
    return Response.json({ error: `key ${want} has no value set in .env.local` }, { status: 400 });
  }

  setActiveOpenAIKey(want);
  await setSystemState(STATE_KEY, want).catch(() => {});

  return Response.json({ ok: true, activeKey: getActiveOpenAIKey(), keys: listOpenAIKeys() });
}
