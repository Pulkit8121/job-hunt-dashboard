const baseUrl = (process.env.CRON_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const cronSecret = process.env.CRON_SECRET;

if (!cronSecret) {
  console.error('Missing CRON_SECRET.');
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runSseTask(path, body, label) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cron-secret': cronSecret,
    },
    body: JSON.stringify(body || {}),
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    throw new Error(`${label} failed (${response.status}): ${text || response.statusText}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';

    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          const payload = JSON.parse(line.slice(6));
          if (payload?.message) console.log(`[${label}] ${payload.message}`);
        } catch {
          console.log(`[${label}] ${line.slice(6)}`);
        }
      }
    }
  }

  if (buffer.trim()) {
    for (const line of buffer.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const payload = JSON.parse(line.slice(6));
        if (payload?.message) console.log(`[${label}] ${payload.message}`);
      } catch {
        console.log(`[${label}] ${line.slice(6)}`);
      }
    }
  }
}

async function runOutreachBranch() {
  const discoverCap = Number(process.env.OUTREACH_DISCOVER_CAP) || 100;
  const sendLimit = Number(process.env.OUTREACH_SEND_LIMIT) || 50;

  await runSseTask('/api/outreach/discover', { cap: discoverCap }, 'outreach-discover');
  await sleep(1000);
  await runSseTask('/api/outreach/send', { limit: sendLimit }, 'outreach-send');
}

async function runLinkedInBranch() {
  const enabled = process.env.ENABLE_LINKEDIN_AUTOMATION === 'true';
  if (!enabled) {
    console.log('[linkedin] skipped (set ENABLE_LINKEDIN_AUTOMATION=true to enable recruiter discovery/connect automation)');
    return;
  }

  const connectLimit = Number(process.env.LINKEDIN_CONNECT_LIMIT) || 20;

  await runSseTask('/api/linkedin-scrape', { companyId: 'all', headless: true }, 'linkedin-scrape');
  await sleep(1000);
  await runSseTask('/api/linkedin-connect', { limit: connectLimit, headless: true }, 'linkedin-connect');
}

async function main() {
  console.log(`[daily] starting at ${new Date().toISOString()}`);

  await runSseTask('/api/discover', {}, 'discover-companies');
  await sleep(1000);
  await runSseTask('/api/scrape', { companyId: 'all', bust: true }, 'scrape-jobs');
  await sleep(1000);

  await Promise.all([
    runSseTask('/api/naukri-apply', {}, 'naukri-apply'),
    runOutreachBranch(),
    runLinkedInBranch(),
  ]);

  console.log(`[daily] finished at ${new Date().toISOString()}`);
}

main().catch((error) => {
  console.error(`[daily] fatal: ${error.message}`);
  process.exit(1);
});
