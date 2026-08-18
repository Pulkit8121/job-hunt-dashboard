// One tick of the continuous company-portal apply loop.
//
// Runs on a short cron (every ~10 minutes). The route it calls is a queue
// drainer, not a discovery sweep, so a tick starts submitting within seconds
// instead of spending 11.6 minutes re-reading 13,385 boards first.
//
// Overlap is handled in two places and needs no lock here: the route refuses
// to start if one is already running, and claimPortalJobs hands out each
// posting to exactly one caller.
const baseUrl = (process.env.CRON_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const cronSecret = process.env.CRON_SECRET;

if (!cronSecret) {
  console.error('Missing CRON_SECRET.');
  process.exit(1);
}

async function stream(path, body, label) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': cronSecret },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok || !res.body) {
    throw new Error(`${label} failed (${res.status}): ${(await res.text().catch(() => '')) || res.statusText}`);
  }
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() || '';
    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const p = JSON.parse(line.slice(6));
          if (p?.message) console.log(`[${label}] ${p.message}`);
        } catch { /* keep-alive padding */ }
      }
    }
  }
}

const queueLow = Number(process.env.PORTAL_QUEUE_LOW_WATER) || 300;

async function main() {
  // Top the queue up only when it runs low. Refilling is the expensive half
  // (a full board sweep), so gating it on depth keeps the common tick cheap
  // while guaranteeing the drainer never starves.
  const stats = await fetch(`${baseUrl}/api/portal-queue/refresh`, {
    headers: { 'x-cron-secret': cronSecret },
  }).then(r => r.json()).catch(() => null);

  if (!stats || (stats.pending ?? 0) < queueLow) {
    console.log(`[tick] queue at ${stats?.pending ?? 'unknown'} (<${queueLow}) — refreshing first`);
    await stream('/api/portal-queue/refresh', {}, 'queue-refresh');
  }

  await stream('/api/company-portal-apply', {}, 'portal-apply');
}

main().catch((e) => {
  console.error(`[tick] fatal: ${e.message}`);
  process.exit(1);
});
