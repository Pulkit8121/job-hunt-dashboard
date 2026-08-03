export const dynamic = 'force-dynamic';

import fs from 'fs';
import path from 'path';
import { readApplied, readOutreachContacts } from '@/lib/db';
import { isRunning as naukriRunning } from '@/lib/naukriRunState';
import { isRunning as naukriBroadRunning } from '@/lib/naukriBroadRunState';
import { isRunning as companyPortalRunning } from '@/lib/companyPortalRunState';
import { isRunning as wellfoundRunning } from '@/lib/wellfoundRunState';
import { isRunning as outreachRunning } from '@/lib/outreachRunState';

// Cron logs live on the same box the app runs on (root's crontab), so we can
// read them directly instead of building separate run-history tracking.
const LOG_DIR = '/root/jobhunt-cron/logs';

const PIPELINES = [
  { id: 'naukri-apply',    label: 'Naukri Apply',        logFile: 'naukri-pipeline.log',      cron: 'Every 4h (:00)',        isRunning: naukriRunning },
  { id: 'naukri-broad',    label: 'Naukri Broad Scrape',  logFile: 'naukri-broad-scrape.log',  cron: '03:30, 15:30 UTC',      isRunning: naukriBroadRunning },
  { id: 'company-portal',  label: 'Company Portals',      logFile: 'company-portal.log',       cron: '06:30, 18:30 UTC',      isRunning: companyPortalRunning },
  { id: 'wellfound',       label: 'Wellfound',            logFile: 'wellfound.log',            cron: '09:30, 21:30 UTC',      isRunning: wellfoundRunning },
  { id: 'outreach-send',   label: 'Outreach — Send',      logFile: 'outreach-send.log',        cron: 'Every hour (:45)',      isRunning: outreachRunning },
  { id: 'outreach-discover', label: 'Outreach — Discover', logFile: 'outreach-discover.log',   cron: 'Every 4h (:30)',        isRunning: null },
];

// Parses the tail of a cron log for the most recent run's start time and its
// last meaningful message (DONE/FATAL/STOPPED line, or the latest progress
// line if the run is still going).
function readLastRun(logFile) {
  const filePath = path.join(LOG_DIR, logFile);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { lastStartedAt: null, lastMessage: null, lastResult: null };
  }

  // Only look at the tail — these logs can grow to tens of MB (naukri-pipeline.log
  // hit 22MB from verbose per-job "no matching jobs found" lines), so read a
  // generous slice rather than the last few KB, which wouldn't even reach the
  // most recent run's start marker.
  const tail = raw.slice(-1500000);
  const lines = tail.split('\n');

  let lastStartedAt = null;
  let lastMessage = null;
  let lastResult = null; // 'success' | 'fatal' | 'stopped' | null

  for (const line of lines) {
    // Format: "=== Mon Aug  3 06:30:01 UTC 2026 company-portal start ===" — match
    // the `date -u` shape directly rather than splitting on the trailing label,
    // since the label itself can contain spaces (e.g. "naukri pipeline").
    const startMatch = line.match(/^=== (\w+ \w+\s+\d+ [\d:]+ UTC \d{4})\b.*\bstart ===/i);
    if (startMatch) lastStartedAt = startMatch[1];

    if (!line.trim().startsWith('data:')) continue;
    const jsonPart = line.trim().slice(5).trim();
    let msg;
    try { msg = JSON.parse(jsonPart).message; } catch { continue; }
    if (!msg) continue;
    lastMessage = msg;
    if (/^DONE:/.test(msg)) lastResult = 'success';
    else if (/^FATAL:/.test(msg)) lastResult = 'fatal';
    else if (/^STOPPED:/.test(msg)) lastResult = 'stopped';
  }

  return { lastStartedAt, lastMessage, lastResult };
}

export async function GET() {
  const pipelines = PIPELINES.map(p => ({
    id: p.id,
    label: p.label,
    cron: p.cron,
    running: p.isRunning ? p.isRunning() : null,
    ...readLastRun(p.logFile),
  }));

  const applied = await readApplied().catch(() => []);
  const bySource = {};
  for (const a of applied) bySource[a.source || 'unknown'] = (bySource[a.source || 'unknown'] || 0) + 1;

  const contacts = await readOutreachContacts().catch(() => []);
  const outreachStats = {
    total: contacts.length,
    pending: contacts.filter(c => c.status === 'pending').length,
    sent: contacts.filter(c => c.status === 'sent').length,
    bounced: contacts.filter(c => c.status === 'bounced').length,
  };

  return Response.json({
    generatedAt: new Date().toISOString(),
    pipelines,
    appliedTotals: { total: applied.length, bySource },
    outreachStats,
  });
}
