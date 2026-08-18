export const dynamic = 'force-dynamic';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { getAppliedCounts, getOutreachCounts } from '@/lib/db';
import { isRunning as naukriRunning } from '@/lib/naukriRunState';
import { isRunning as naukriBroadRunning } from '@/lib/naukriBroadRunState';
import { isRunning as companyPortalRunning } from '@/lib/companyPortalRunState';
import { isRunning as wellfoundRunning } from '@/lib/wellfoundRunState';
import { isRunning as outreachRunning } from '@/lib/outreachRunState';

// Cron logs live on the same box the app runs on (root's crontab), so we can
// read them directly instead of building separate run-history tracking.
const LOG_DIR = '/root/jobhunt-cron/logs';

const PIPELINES = [
  { id: 'naukri-apply',    label: 'Naukri Apply',        logFile: 'naukri-pipeline.log',      cron: 'Every 15 min',          isRunning: naukriRunning },
  { id: 'naukri-broad',    label: 'Naukri Broad Scrape',  logFile: 'naukri-broad-scrape.log',  cron: '03:30, 15:30 UTC',      isRunning: naukriBroadRunning },
  { id: 'company-portal',  label: 'Company Portals',      logFile: 'company-portal.log',       cron: 'Every 15 min (offset)', isRunning: companyPortalRunning },
  { id: 'wellfound',       label: 'Wellfound',            logFile: 'wellfound.log',            cron: '09:30, 21:30 UTC',      isRunning: wellfoundRunning },
  { id: 'outreach-send',   label: 'Outreach — Send',      logFile: 'outreach-send.log',        cron: 'Manual (cron removed)', isRunning: outreachRunning },
  { id: 'outreach-discover', label: 'Outreach — Discover', logFile: 'outreach-discover.log',   cron: 'Every 4h (:30)',        isRunning: null },
  { id: 'ats-sweep',       label: 'ATS Sweep',            logFile: 'ats-sweep.log',            cron: 'Every 6h (:20)',        isRunning: null },
];

// Load-gate + browser-lock skip messages land as plain (non-"data:") lines in
// the same cron logs — surface the most recent one so a quiet cycle is
// legible as "skipped, system was busy" rather than looking like nothing ran.
function readLastSkip(logFile) {
  const filePath = path.join(LOG_DIR, logFile);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  const tail = raw.slice(-50000);
  const lines = tail.split('\n').filter(l => /load-gate closed|browser lock busy/.test(l));
  return lines.length ? lines[lines.length - 1].trim() : null;
}

const LOAD_GATE_HIGH = 4.0;
const SWAP_GATE_PCT = 80;

function readSwapPercent() {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8');
    const total = Number(meminfo.match(/SwapTotal:\s+(\d+)/)?.[1] || 0);
    const free = Number(meminfo.match(/SwapFree:\s+(\d+)/)?.[1] || 0);
    return total > 0 ? Math.round(((total - free) / total) * 100) : 0;
  } catch {
    return null;
  }
}

function readDiskPercent() {
  try {
    // statfsSync isn't in older Node — fall back gracefully if unavailable.
    const stat = fs.statfsSync('/');
    const used = stat.blocks - stat.bfree;
    return Math.round((used / stat.blocks) * 100);
  } catch {
    return null;
  }
}

function readSystemHealth() {
  const [load1, load5, load15] = os.loadavg();
  const swapPercent = readSwapPercent();
  const diskPercent = readDiskPercent();
  const cpuCount = os.cpus().length;
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const memPercent = Math.round(((memTotal - memFree) / memTotal) * 100);

  const gated = load1 > LOAD_GATE_HIGH || (swapPercent !== null && swapPercent > SWAP_GATE_PCT);

  return {
    load1, load5, load15,
    cpuCount,
    memPercent,
    swapPercent,
    diskPercent,
    gated, // true when the load-gate would currently skip a new cron cycle
    loadGateThreshold: LOAD_GATE_HIGH,
    swapGateThreshold: SWAP_GATE_PCT,
  };
}

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
    lastSkip: readLastSkip(p.logFile),
    ...readLastRun(p.logFile),
  }));

  const systemHealth = readSystemHealth();

  const appliedTotals = await getAppliedCounts().catch(() => ({ total: 0, bySource: {} }));
  const outreachStats = await getOutreachCounts().catch(() => ({ total: 0, pending: 0, sent: 0, bounced: 0 }));

  return Response.json({
    generatedAt: new Date().toISOString(),
    systemHealth,
    pipelines,
    appliedTotals,
    outreachStats,
  });
}
