export const dynamic = 'force-dynamic';

import fs from 'fs';
import path from 'path';
import { readApplied, readOutreachContacts, readCompanies, getIdentitySettings } from '@/lib/db';
import { listIdentities } from '@/lib/identities';
import { sendPlainEmail } from '@/lib/mailer';
import { getDailyCap, countSentToday } from '@/lib/outreachCap';

const REPORT_TO = 'pulkitagarwal2015@gmail.com';
const LOG_DIR = '/root/jobhunt-cron/logs';
const LOG_FILES = [
  'naukri-pipeline.log', 'naukri-broad-scrape.log', 'company-portal.log',
  'wellfound.log', 'linkedin-pipeline.log', 'ats-sweep.log',
  'discover-companies.log', 'outreach-discover.log',
];

function sinceYesterday(date) {
  if (!date) return false;
  return new Date(date).getTime() >= Date.now() - 24 * 60 * 60 * 1000;
}

// Scans the tail of every cron log for FATAL lines in the last 24h, so a
// silently-broken pipeline (bad selector, expired session, etc.) shows up in
// the report instead of only being visible if someone happens to check logs.
function recentFatals() {
  const fatals = [];
  for (const file of LOG_FILES) {
    try {
      const raw = fs.readFileSync(path.join(LOG_DIR, file), 'utf-8');
      const tail = raw.slice(-200000);
      const lines = tail.split('\n');
      let currentStart = null;
      for (const line of lines) {
        const startMatch = line.match(/^=== (\w+ \w+\s+\d+ [\d:]+ UTC \d{4})\b/i);
        if (startMatch) currentStart = new Date(startMatch[1] + '');
        if (!line.includes('"FATAL:')) continue;
        if (currentStart && !sinceYesterday(currentStart)) continue;
        const msgMatch = line.match(/"message":\s*"([^"]*FATAL:[^"]*)"/);
        if (msgMatch) fatals.push(`${file}: ${msgMatch[1].slice(0, 200)}`);
      }
    } catch { /* log doesn't exist yet — fine */ }
  }
  return fatals.slice(-15); // cap — a genuinely broken pipeline could log many
}

async function buildReport() {
  const applied = await readApplied().catch(() => []);
  const appliedToday = applied.filter(a => sinceYesterday(a.appliedAt || a.createdAt));
  const bySource = {};
  for (const a of appliedToday) bySource[a.source || 'unknown'] = (bySource[a.source || 'unknown'] || 0) + 1;

  const contacts = await readOutreachContacts().catch(() => []);
  // "Last 24h" is a rolling window from whenever this report happens to run —
  // it straddles two calendar days, so summing it per identity can look like
  // it "crossed" the daily cap (e.g. 176 shown against a 150 limit) even
  // though the cap itself is enforced per UTC calendar day and was never
  // actually exceeded on either individual day. Report both: the rolling
  // total for "how much happened since last night", and the calendar-day
  // count (matching the cap's own isToday()) so cap usage is directly
  // comparable and can never appear to exceed the configured limit.
  const sentToday = contacts.filter(c => c.status === 'sent' && sinceYesterday(c.sentAt));
  const bouncedToday = contacts.filter(c => c.status === 'bounced' && sinceYesterday(c.updatedAt));
  const byIdentity = {};
  for (const c of sentToday) byIdentity[c.sentFromIdentity || 'unknown'] = (byIdentity[c.sentFromIdentity || 'unknown'] || 0) + 1;

  const followedUpToday = contacts.filter(c => c.followUpSentAt && sinceYesterday(c.followUpSentAt));
  const referredToday = contacts.filter(c => c.altContactEmail && sinceYesterday(c.repliedAt));

  const companies = await readCompanies().catch(() => []);
  const atsEligible = companies.filter(c => ['greenhouse', 'lever', 'ashby'].includes(c.atsType) && c.atsSlug).length;

  const identities = listIdentities();
  const fatals = recentFatals();

  const lines = [];
  lines.push(`Job Hunt Dashboard — Daily Report (${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })}, last 24h)`);
  lines.push('');
  lines.push('APPLICATIONS');
  lines.push(`  Total applied (24h): ${appliedToday.length}`);
  for (const [source, count] of Object.entries(bySource)) lines.push(`    - ${source}: ${count}`);
  lines.push(`  Total applied all-time: ${applied.length}`);
  lines.push(`  Companies eligible for auto-apply (Greenhouse/Lever/Ashby): ${atsEligible} of ${companies.length} tracked`);
  lines.push('');
  lines.push('OUTREACH EMAILS');
  lines.push(`  Sent (last 24h, rolling): ${sentToday.length}`);
  for (const i of identities) lines.push(`    - ${i.label}: ${byIdentity[i.id] || 0} sent${i.configured ? '' : ' (not configured)'}`);
  lines.push(`  Sent today (calendar day so far — what counts against the daily cap):`);
  for (const i of identities) {
    if (!i.configured) { lines.push(`    - ${i.label}: not configured`); continue; }
    const settings = await getIdentitySettings(i.id).catch(() => ({}));
    const cap = getDailyCap(settings);
    const usedToday = countSentToday(contacts, i.id);
    lines.push(`    - ${i.label}: ${usedToday}/${cap}`);
  }
  lines.push(`  Bounced (24h): ${bouncedToday.length}`);
  lines.push(`  Still pending in queue: ${contacts.filter(c => c.status === 'pending').length}`);
  lines.push('');
  lines.push('FOLLOW-UPS (last 24h)');
  if (followedUpToday.length || referredToday.length) {
    if (followedUpToday.length) {
      lines.push(`  Reply follow-ups sent: ${followedUpToday.length}`);
      for (const c of followedUpToday) {
        lines.push(`    - ${c.email} (${c.companyName || 'unknown company'}) — ${c.followUpReason === 'relocation' ? 'open to relocating' : 'stay-in-touch after no opening'}`);
      }
    }
    if (referredToday.length) {
      lines.push(`  Referred to a new contact address: ${referredToday.length}`);
      for (const c of referredToday) {
        lines.push(`    - ${c.email} → ${c.altContactEmail} (${c.companyName || 'unknown company'})`);
      }
    }
  } else {
    lines.push('  None.');
  }
  lines.push('');
  lines.push('ERRORS / ISSUES (last 24h)');
  if (fatals.length) {
    for (const f of fatals) lines.push(`  - ${f}`);
  } else {
    lines.push('  None logged.');
  }
  lines.push('');
  lines.push('This report is auto-generated nightly at 00:00 IST. No action needed unless something above looks wrong.');

  return { text: lines.join('\n'), appliedToday: appliedToday.length, sentToday: sentToday.length, fatalCount: fatals.length };
}

export async function POST() {
  try {
    const { text, appliedToday, sentToday, fatalCount } = await buildReport();
    await sendPlainEmail({
      to: REPORT_TO,
      subject: `Job Hunt Daily Report — ${appliedToday} applied, ${sentToday} emails sent${fatalCount ? `, ${fatalCount} error(s)` : ''}`,
      text,
    });
    return Response.json({ success: true, appliedToday, sentToday, fatalCount });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
