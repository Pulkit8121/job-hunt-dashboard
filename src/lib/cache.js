// Redis cache for scraped job results — falls back silently if Redis is unavailable
let client = null;

async function getClient() {
  if (!process.env.REDIS_URL) return null;
  if (client) return client;
  try {
    const { createClient } = await import('redis');
    client = createClient({ url: process.env.REDIS_URL });
    client.on('error', () => { client = null; });
    await client.connect();
    return client;
  } catch {
    client = null;
    return null;
  }
}

export async function cacheGet(key) {
  try {
    const c = await getClient();
    if (!c) return null;
    const val = await c.get(key);
    return val ? JSON.parse(val) : null;
  } catch {
    return null;
  }
}

// Cache for 2 hours by default
export async function cacheSet(key, value, ttlSeconds = 7200) {
  try {
    const c = await getClient();
    if (!c) return;
    await c.set(key, JSON.stringify(value), { EX: ttlSeconds });
  } catch {}
}

export async function cacheDel(key) {
  try {
    const c = await getClient();
    if (!c) return;
    await c.del(key);
  } catch {}
}
