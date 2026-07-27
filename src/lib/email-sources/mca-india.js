// Indian company contact emails from the MCA "Company Master Data" release on
// data.gov.in.
//
// This is the highest-volume free source for Indian companies specifically:
// each state is published as its own resource, and 78 of ~100 resources carry
// a populated `email_addr` column. Karnataka alone is 139,292 rows.
//
// What these addresses ARE: the registered-office / statutory contact filed
// with the Registrar of Companies.
// What they are NOT: recruiters. In practice they are often the company's CA,
// auditor, or a founder's own mailbox at small firms. That makes this a good
// source for small and mid-size Bengaluru companies where the founder reads
// that inbox, and a poor one for MNC subsidiaries where it reaches a
// compliance department.
//
// Snapshots are dated (2018 / 2019 / 2021), so expect some decay — worth
// MX-checking a domain before trusting it.
//
// Auth: needs a free data.gov.in API key in DATA_GOV_IN_API_KEY. Without one it
// falls back to the publicly documented sample key, which is HARD-CAPPED at 10
// records per request (verified: limit=10/100/500/1000 all return 10). That
// makes the sample key fine for a smoke test but useless at volume — 139k
// Karnataka rows would need ~14k requests. Register a free key to raise the
// page size (typically 1000) before relying on this source.
const SAMPLE_KEY = '579b464db66ec23bdd000001cdd3946e44ce4aad7209ff7b23ac571b';
const BASE = 'https://api.data.gov.in/resource';
const TIMEOUT = 25000;

// Resource ids per state. Karnataka verified live (139,292 rows, populated
// email_addr). Others follow the same schema; add ids as needed.
export const MCA_RESOURCES = {
  karnataka: '77cdb9fb-a407-432b-881d-33d02074a6eb',
};

function apiKey() {
  return process.env.DATA_GOV_IN_API_KEY || SAMPLE_KEY;
}

// Industrial-class / activity strings that indicate a software or IT company —
// used to filter ~139k rows down to plausible employers for a developer.
const IT_ACTIVITY_RE = /(software|information technology|computer|data process|it enabled|consultancy|technolog|internet|web|business services)/i;

function cleanEmail(raw) {
  const e = (raw || '').trim().toLowerCase();
  if (!e || e === 'na' || e === 'n/a' || e === '-' || !e.includes('@')) return null;
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) return null;
  return e;
}

function titleCase(s = '') {
  return s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()).trim();
}

// Streams a state resource page by page.
// Returns [{ companyName, email, city, activity, cin, status }]
export async function fetchMcaCompanies({
  state = 'karnataka',
  limit = 500,
  maxPages = 10,
  itOnly = true,
  activeOnly = true,
  onProgress = () => {},
} = {}) {
  const resource = MCA_RESOURCES[state];
  if (!resource) throw new Error(`no MCA resource id known for state "${state}"`);

  const out = [];
  const seenEmails = new Set();
  // The server may cap page size below what we ask for (the sample key returns
  // 10 no matter what). Offsets must advance by what we actually GET, or we
  // silently skip rows; and "short page" must not be treated as "last page".
  let pageSize = limit;
  let offset = 0;
  let usedSampleKeyWarning = false;

  for (let page = 0; page < maxPages; page++) {
    const url = `${BASE}/${resource}?api-key=${encodeURIComponent(apiKey())}&format=json&limit=${limit}&offset=${offset}`;

    let body;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
      if (!res.ok) {
        onProgress(`⚠ MCA ${state} page ${page + 1}: HTTP ${res.status}`);
        break;
      }
      body = await res.json();
    } catch (e) {
      onProgress(`⚠ MCA ${state} page ${page + 1}: ${e.message.slice(0, 60)}`);
      break;
    }

    const records = body?.records || [];
    if (!records.length) break; // genuinely exhausted

    if (page === 0) {
      pageSize = records.length;
      if (pageSize < limit && !process.env.DATA_GOV_IN_API_KEY && !usedSampleKeyWarning) {
        usedSampleKeyWarning = true;
        onProgress(`⚠ Server capped page size at ${pageSize} (asked ${limit}). Set DATA_GOV_IN_API_KEY (free) for full-size pages — otherwise this source is smoke-test only.`);
      }
    }
    offset += records.length;

    let kept = 0;
    for (const r of records) {
      const email = cleanEmail(r.email_addr);
      if (!email || seenEmails.has(email)) continue;

      if (activeOnly && r.company_status && !/active/i.test(r.company_status)) continue;

      const activity = r.principal_business_activity_as_per_cin || r.industrial_class || '';
      if (itOnly && !IT_ACTIVITY_RE.test(activity) && !IT_ACTIVITY_RE.test(r.company_name || '')) continue;

      seenEmails.add(email);
      out.push({
        companyName: titleCase(r.company_name || ''),
        email,
        activity,
        cin: r.corporate_identification_number || '',
        status: r.company_status || '',
        state,
      });
      kept++;
    }

    onProgress(`… MCA ${state} offset ${offset}: ${records.length} rows scanned, ${kept} kept (running total ${out.length})`);
    // Only stop on a page shorter than the established page size — a short
    // FIRST page just means the server capped us, not that data ran out.
    if (page > 0 && records.length < pageSize) break;
  }

  return out;
}

export { IT_ACTIVITY_RE };
