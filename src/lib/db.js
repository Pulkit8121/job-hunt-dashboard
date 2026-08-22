// Database connection and data access helpers for JobHuntDashboard
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { filterEligibleJobs } from './matcher.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const useMongo = !!process.env.MONGODB_URI;

const SOURCE_PRIORITY = {
  'careers-page': 0, 'career-agent': 0, 'greenhouse': 0, 'lever': 0,
  'wellfound': 2, 'naukri': 3,
};

function sortJobsBySource(jobs) {
  return jobs.slice().sort((a, b) => {
    const pa = SOURCE_PRIORITY[a.source] ?? 1;
    const pb = SOURCE_PRIORITY[b.source] ?? 1;
    if (pa !== pb) return pa - pb;
    return (b.matchScore || 0) - (a.matchScore || 0);
  });
}

// ── MongoDB connection ────────────────────────────────────────────────────────
let cached = global._mongoose;
if (!cached) cached = global._mongoose = { conn: null, promise: null };
let metadataBackfilled = false;

async function connectDB() {
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    cached.promise = mongoose.connect(process.env.MONGODB_URI, { bufferCommands: false });
  }
  cached.conn = await cached.promise;
  return cached.conn;
}

// ── Mongoose schemas ──────────────────────────────────────────────────────────
const CompanySchema = new mongoose.Schema({
  id:                  { type: String, required: true, unique: true },
  name:                { type: String, required: true },
  type:                { type: String, default: 'unknown' },
  workMode:            { type: String, default: 'unknown' },
  difficulty:          String,
  interviewNote:       String,
  locations:           [String],
  careersUrl:          String,
  naukriSearchUrl:     String,
  wellfoundUrl:        String,
  linkedinCompanyName: String,
  salaryRange:         String,
  atsType:             { type: String, default: 'naukri' },
  atsSlug:             String,
  // When this company was last probed for an ATS board. The sweep had no
  // memory of what it had already looked at — it took `.slice(0, limit)` off
  // a stably-ordered list, so it re-probed the same first 400 companies every
  // single day and the remaining 4,953 were never checked once. Ordering by
  // this field turns the sweep into a rotation that eventually covers
  // everyone. A 5.3% hit rate measured on a 150-company sample of the
  // never-probed tail puts roughly 264 undiscovered boards in there.
  atsCheckedAt:        Date,
  // Email format used org-wide (e.g. 'first.last'), learned from a confirmed
  // address. Companies use one format throughout, so this lets us address
  // anyone whose name we know instead of blind-guessing.
  emailPattern:        String,
  githubOrg:           String,
  lastScraped:         Date,
  autoDiscovered:      { type: Boolean, default: false },
}, { timestamps: true });

const JobSchema = new mongoose.Schema({
  companyId:     { type: String, required: true, index: true },
  title:         String,
  jobId:         String,
  link:          { type: String, index: true },
  location:      String,
  experienceText:String,
  description:   String,
  source:        String,
  postedDate:    String,
  matchScore:    Number,
  matchTier:     String,
  matchedSkills: [String],
  aiSummary:     String,
  isEasyApply:   { type: Boolean, default: false },
  atsType:       String, // 'greenhouse' | 'lever' | 'ashby' | 'workday' — set by company-portal-discovery
}, { timestamps: true });

const LinkedInPersonSchema = new mongoose.Schema({
  companyId:       { type: String, required: true, index: true },
  name:            String,
  title:           String,
  profileUrl:      { type: String, unique: true },
  searchType:      String,
  connected:       { type: Boolean, default: false },
  connectionSentAt:Date,
  scrapedAt:       { type: Date, default: Date.now },
}, { timestamps: true });

const AppliedJobSchema = new mongoose.Schema({
  companyId:  { type: String, required: true, index: true },
  companyName:String,
  jobTitle:   String,
  jobLink:    String,
  source:     String,
  appliedAt:  { type: Date, default: Date.now },
  status:     { type: String, default: 'applied' },
}, { timestamps: true });

const SkippedJobSchema = new mongoose.Schema({
  link:   { type: String, required: true, unique: true },
  reason: String,
  skippedAt: { type: Date, default: Date.now },
  // Retry bookkeeping. Most skip reasons are NOT permanent facts about the job
  // — "no-apply-button" is usually a stale/expired listing, a page that hadn't
  // finished rendering, or a lost login session, and "form-validation-error" is
  // usually a field the filler didn't understand yet. Recording every one of
  // those as a permanent tombstone is what emptied the apply queue: 2,287 jobs
  // were retired for "no-apply-button" alone and could never be reconsidered.
  // These two fields let RETRYABLE_SKIP_REASONS come back after a cooldown,
  // while still guaranteeing forward progress via a hard attempt ceiling.
  attempts:      { type: Number, default: 1 },
  lastAttemptAt: { type: Date, default: Date.now },
});

const OutreachContactSchema = new mongoose.Schema({
  companyId:    String,
  companyName:  { type: String, required: true },
  email:        { type: String, required: true, unique: true },
  source:       String,  // 'careers-page' | 'company-site' | 'search'
  confidence:   { type: String, default: 'medium' }, // 'high' | 'medium' | 'low'
  status:       { type: String, default: 'pending' }, // pending | sent | skipped | bounced | invalid
  sentAt:       Date,
  coverLetter:  String,
  sentFromIdentity: String, // 'primary' | 'secondary' — which Gmail account + resume this went out from
  failCount:    { type: Number, default: 0 },
  lastFailReason: String,
  replyStatus:  String,  // interested | rejected | auto-reply | other
  replySnippet: String,
  repliedAt:    Date,
  // Detected from a reply: a different email the sender asked us to use
  // instead (auto-enqueued as a new 'referred' contact — see check-replies),
  // and whether they raised a location-based objection (e.g. "we're only
  // hiring in Belgium/Europe") that triggers a relocation follow-up.
  altContactEmail:  String,
  locationObjection: Boolean,
  followUpSentAt:   Date,   // when the follow-up reply went out, if any
  followUpReason:   String, // 'relocation' | 'no-opening'
  discoveredAt: { type: Date, default: Date.now },
}, { timestamps: true });

// Per-identity outreach controls, editable from the dashboard — a manual
// "how many to send today" override and an automatic-sending on/off switch.
// Separate from OUTREACH_DAILY_CAP (the global env fallback): dailyLimit here
// is the hard per-identity ceiling that BOTH the bulk queue-send route and the
// one-off manual-send route enforce against the same running total, so a mix
// of automatic + manual sends can never together cross it.
const IdentitySettingsSchema = new mongoose.Schema({
  identityId:      { type: String, required: true, unique: true }, // 'primary' | 'secondary'
  dailyLimit:      { type: Number, default: 150 },
  autoSendEnabled: { type: Boolean, default: true },
}, { timestamps: true });

const MailInsightSchema = new mongoose.Schema({
  messageId: { type: String, required: true, unique: true },
  from:      String,
  subject:   String,
  snippet:   String,
  category:  String, // 'positive' | 'assessment' | 'rejected' | 'other'
  receivedAt:Date,
  scannedAt: { type: Date, default: Date.now },
  mailbox:   String, // which identity's inbox this was found in
}, { timestamps: true });

// Generic key/value store for small pieces of state that need to survive a
// pm2 restart (unlike the in-memory RunState modules) — e.g. "when did we
// last email a CAPTCHA alert", so a 5-minute cron doesn't re-send it every
// cycle. Not meant for anything larger than a timestamp/flag.
// A job board that exists in the world, independent of whether we track the
// company behind it. This is the collection the portal apply flow reads from.
// Keeping it separate from `companies` is the point: company records are an
// India/Naukri-shaped list that happens to include a few ATS users, whereas
// this is the ATS universe itself.
const AtsBoardSchema = new mongoose.Schema({
  atsType:      { type: String, required: true },
  slug:         { type: String, required: true },
  name:         String,
  source:       String,  // 'directory' | 'cdx' | 'company-sweep'
  // Liveness, established by probing the board's public API rather than
  // trusting the directory listing.
  alive:        { type: Boolean, default: null },
  jobCount:     { type: Number, default: 0 },
  lastProbedAt: Date,
  lastError:    String,
}, { timestamps: true });
AtsBoardSchema.index({ atsType: 1, slug: 1 }, { unique: true });
// The apply flow asks for "live boards, least recently probed first".
AtsBoardSchema.index({ alive: 1, lastProbedAt: 1 });

// A discovered, not-yet-attempted company-portal posting.
//
// This exists to decouple discovery from applying. The apply route used to
// sweep every live board itself before submitting anything: measured at 52ms
// per board across 13,385 boards, that is 11.6 minutes of pure discovery
// before the first application — 78% of a 15-minute cycle. Continuous
// operation is impossible while every tick pays that cost.
//
// Discovery now writes here on a slow cadence and the apply loop just drains
// the queue, so an apply tick starts submitting within seconds.
const PortalJobSchema = new mongoose.Schema({
  link:        { type: String, required: true, unique: true },
  atsType:     String,
  atsSlug:     String,
  companyId:   String,
  companyName: String,
  title:       String,
  location:    String,
  // pending -> applied | skipped. Anything not pending is terminal for this
  // posting; re-discovery must not resurrect it.
  status:      { type: String, default: 'pending', index: true },
  reason:      String,
  attempts:    { type: Number, default: 0 },
  discoveredAt:{ type: Date, default: Date.now },
  attemptedAt: Date,
}, { timestamps: true });
// The drain query: oldest pending first.
PortalJobSchema.index({ status: 1, discoveredAt: 1 });

const SystemStateSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true },
  value: mongoose.Schema.Types.Mixed,
}, { timestamps: true });

// Persistent cache of screening-question answers, so a question we've already
// reasoned about once is answered instantly (and identically) next time
// instead of burning an LLM call per application.
const QuestionAnswerSchema = new mongoose.Schema({
  key:      { type: String, required: true, unique: true }, // question text + option set
  question: String,
  answer:   String,
  source:   String, // 'rule' | 'ai'
  usedCount:{ type: Number, default: 1 },
}, { timestamps: true });

const Company        = mongoose.models.Company        || mongoose.model('Company',        CompanySchema);
const Job            = mongoose.models.Job            || mongoose.model('Job',            JobSchema);
const LinkedInPerson = mongoose.models.LinkedInPerson  || mongoose.model('LinkedInPerson',  LinkedInPersonSchema);
const AppliedJob     = mongoose.models.AppliedJob      || mongoose.model('AppliedJob',      AppliedJobSchema);
const SkippedJob     = mongoose.models.SkippedJob      || mongoose.model('SkippedJob',      SkippedJobSchema);
const OutreachContact= mongoose.models.OutreachContact || mongoose.model('OutreachContact', OutreachContactSchema);
const MailInsight    = mongoose.models.MailInsight     || mongoose.model('MailInsight',     MailInsightSchema);
const QuestionAnswer = mongoose.models.QuestionAnswer  || mongoose.model('QuestionAnswer',  QuestionAnswerSchema);
const IdentitySettings = mongoose.models.IdentitySettings || mongoose.model('IdentitySettings', IdentitySettingsSchema);
const SystemState    = mongoose.models.SystemState     || mongoose.model('SystemState',     SystemStateSchema);
const AtsBoard       = mongoose.models.AtsBoard        || mongoose.model('AtsBoard',        AtsBoardSchema);
const PortalJob      = mongoose.models.PortalJob       || mongoose.model('PortalJob',       PortalJobSchema);

// ── JSON file helpers ─────────────────────────────────────────────────────────
function jsonReadCompanies() {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'companies.json'), 'utf-8'));
}
function jsonWriteCompanies(data) {
  fs.writeFileSync(path.join(DATA_DIR, 'companies.json'), JSON.stringify(data, null, 2));
}
function jsonReadJobs() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'jobs.json'), 'utf-8')); }
  catch { return []; }
}
function jsonWriteJobs(data) {
  fs.writeFileSync(path.join(DATA_DIR, 'jobs.json'), JSON.stringify(data, null, 2));
}
function jsonReadPeople() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'linkedin-people.json'), 'utf-8')); }
  catch { return []; }
}
function jsonWritePeople(data) {
  fs.writeFileSync(path.join(DATA_DIR, 'linkedin-people.json'), JSON.stringify(data, null, 2));
}
function jsonReadApplied() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'applied-jobs.json'), 'utf-8')); }
  catch { return []; }
}
function jsonWriteApplied(data) {
  fs.writeFileSync(path.join(DATA_DIR, 'applied-jobs.json'), JSON.stringify(data, null, 2));
}
function jsonReadSkipped() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'skipped-jobs.json'), 'utf-8')); }
  catch { return []; }
}
function jsonWriteSkipped(data) {
  fs.writeFileSync(path.join(DATA_DIR, 'skipped-jobs.json'), JSON.stringify(data, null, 2));
}
function jsonReadOutreach() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'outreach-contacts.json'), 'utf-8')); }
  catch { return []; }
}
function jsonWriteOutreach(data) {
  fs.writeFileSync(path.join(DATA_DIR, 'outreach-contacts.json'), JSON.stringify(data, null, 2));
}
function jsonReadAnswers() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'question-answers.json'), 'utf-8')); }
  catch { return []; }
}
function jsonWriteAnswers(data) {
  fs.writeFileSync(path.join(DATA_DIR, 'question-answers.json'), JSON.stringify(data, null, 2));
}
function jsonReadMailInsights() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'mail-insights.json'), 'utf-8')); }
  catch { return []; }
}
function jsonWriteMailInsights(data) {
  fs.writeFileSync(path.join(DATA_DIR, 'mail-insights.json'), JSON.stringify(data, null, 2));
}
function jsonReadSystemState() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'system-state.json'), 'utf-8')); }
  catch { return {}; }
}
function jsonWriteSystemState(data) {
  fs.writeFileSync(path.join(DATA_DIR, 'system-state.json'), JSON.stringify(data, null, 2));
}

// ── Seed + backfill ───────────────────────────────────────────────────────────
async function seedIfEmpty() {
  const count = await Company.countDocuments();
  if (count > 0) return;
  const seed = jsonReadCompanies();
  await Company.insertMany(seed, { ordered: false }).catch(() => {});
  console.log(`[DB] Seeded ${seed.length} companies into MongoDB`);
}

async function backfillCompanyMetadata() {
  if (metadataBackfilled) return;
  const seed = jsonReadCompanies();
  const ops = [];
  for (const company of seed) {
    for (const field of ['difficulty', 'interviewNote']) {
      if (company[field]) {
        ops.push({
          updateOne: {
            filter: { id: company.id, $or: [{ [field]: { $exists: false } }, { [field]: null }, { [field]: '' }] },
            update: { $set: { [field]: company[field] } },
          },
        });
      }
    }
  }
  if (ops.length) await Company.bulkWrite(ops, { ordered: false }).catch(() => {});
  metadataBackfilled = true;
}

// ── Companies ─────────────────────────────────────────────────────────────────
export async function readCompanies() {
  if (!useMongo) return jsonReadCompanies();
  await connectDB();
  await seedIfEmpty();
  await backfillCompanyMetadata();
  return Company.find().lean().sort({ name: 1 });
}

export async function addCompany(data) {
  if (!useMongo) {
    const companies = jsonReadCompanies();
    if (companies.find(c => c.id === data.id)) throw Object.assign(new Error('exists'), { code: 11000 });
    companies.push(data);
    jsonWriteCompanies(companies);
    return data;
  }
  await connectDB();
  return Company.create(data);
}

export async function updateCompany(id, update) {
  if (!useMongo) {
    const companies = jsonReadCompanies();
    const idx = companies.findIndex(c => c.id === id);
    if (idx >= 0) Object.assign(companies[idx], update);
    jsonWriteCompanies(companies);
    return;
  }
  await connectDB();
  return Company.findOneAndUpdate({ id }, update);
}

// ── Jobs ──────────────────────────────────────────────────────────────────────
// The jobs collection has grown to 14k+ documents. Measured directly against
// this box's connection to Atlas: a consistent ~7ms/doc regardless of
// document size (network latency to the cluster, not payload weight) — so an
// unfiltered fetch-everything call here took 40-60s+ and is what caused live
// 504s on /api/jobs. Capped to the most recent DEFAULT_JOB_LIMIT when no
// companyId narrows the query; sorting by _id (not a separate timestamp
// field) reuses Mongo's existing default index for a fast top-N instead of a
// full-collection sort. 500 keeps this at ~3.5s instead of 60s+; the real fix
// for a truly snappy dashboard is separating fast aggregate counts from a
// small paginated list, not raising this number.
const DEFAULT_JOB_LIMIT = 500;

export async function readJobs(companyId) {
  if (!useMongo) {
    const jobs = jsonReadJobs();
    const filtered = companyId ? jobs.filter(j => j.companyId === companyId) : jobs;
    return sortJobsBySource(filterEligibleJobs(filtered, Number.MAX_SAFE_INTEGER).eligible);
  }
  await connectDB();
  const filter = companyId ? { companyId } : {};
  let query = Job.find(filter).lean();
  if (!companyId) query = query.sort({ _id: -1 }).limit(DEFAULT_JOB_LIMIT);
  const jobs = await query;
  return sortJobsBySource(filterEligibleJobs(jobs, Number.MAX_SAFE_INTEGER).eligible);
}

// Builds the Naukri auto-apply queue.
//
// This replaces `readJobsRaw({ linkContains: 'naukri.com' })` + client-side
// skip filtering, which measured at literally ZERO throughput: readJobsRaw
// caps at the newest DEFAULT_JOB_LIMIT (500) documents BEFORE the caller gets
// to drop already-skipped links, and with 4,043 skip tombstones accumulated
// against 14,185 stored Naukri jobs, all 492 unique links in that newest-500
// window were already skipped. Every run therefore opened with an empty
// target list and applied to nothing, which is the direct cause of the 1-2
// applications/day the dashboard was reporting.
//
// Fix: page through newest-first in chunks and filter as we go, stopping as
// soon as `limit` genuinely-queueable jobs are found — so the window slides
// past the tombstones instead of being blocked by them.
export async function readNaukriApplyQueue({ limit = 300, skippedLinks = new Set(), maxAgeDays = null } = {}) {
  const FIELDS = 'link title jobId companyId createdAt';
  const CHUNK = 2000;
  const MAX_SCAN = 20000; // hard bound so a fully-exhausted collection can't spin
  const cutoff = maxAgeDays ? Date.now() - maxAgeDays * 86400000 : null;

  const out = [];
  const seen = new Set();
  const take = (rows) => {
    for (const j of rows) {
      if (!j.link?.includes('naukri.com')) continue;
      const key = j.link.split('?')[0];
      if (seen.has(key) || skippedLinks.has(key)) continue;
      if (cutoff && j.createdAt && new Date(j.createdAt).getTime() < cutoff) continue;
      seen.add(key);
      out.push(j);
      if (out.length >= limit) return true;
    }
    return false;
  };

  if (!useMongo) {
    const jobs = jsonReadJobs().slice().reverse();
    take(jobs);
    return out;
  }

  await connectDB();
  let cursorId = null;
  let scanned = 0;
  while (out.length < limit && scanned < MAX_SCAN) {
    const filter = { link: { $regex: 'naukri\\.com' } };
    if (cursorId) filter._id = { $lt: cursorId };
    const rows = await Job.find(filter, FIELDS).sort({ _id: -1 }).limit(CHUNK).lean();
    if (!rows.length) break;
    scanned += rows.length;
    cursorId = rows[rows.length - 1]._id;
    if (take(rows)) break;
  }
  return out;
}

// opts.linkContains / opts.fields let a caller that only needs a narrow slice
// (e.g. naukri-apply only cares about naukri.com links, and only 4 small
// fields) avoid paying for every job's full `description`/`aiSummary` text —
// confirmed live that pulling the whole collection (14k+ jobs, most with a
// few KB of description each) made this single call take 60s+, which in turn
// made naukri-apply's cron cycle long enough to starve company-portal of the
// shared browser lock every time. Callers that need everything (e.g. the
// company-scoped read) are unaffected — opts is optional.
export async function readJobsRaw(companyId, opts = {}) {
  const { linkContains, fields } = opts;
  if (!useMongo) {
    const jobs = jsonReadJobs();
    let filtered = companyId ? jobs.filter(j => j.companyId === companyId) : jobs;
    if (linkContains) filtered = filtered.filter(j => j.link?.includes(linkContains));
    return sortJobsBySource(filtered);
  }
  await connectDB();
  const filter = companyId ? { companyId } : {};
  if (linkContains) filter.link = { $regex: linkContains };
  // linkContains alone doesn't bound the result size — almost every job in
  // this collection is a naukri.com link, so that filter barely narrows
  // anything; the limit is what actually caps the fetch (measured taking
  // 40s+ without it, which starved the shared browser lock on every cycle).
  let query = Job.find(filter, fields).lean();
  if (!companyId) query = query.sort({ _id: -1 }).limit(DEFAULT_JOB_LIMIT);
  const jobs = await query;
  return sortJobsBySource(jobs);
}

export async function replaceJobsForCompany(companyId, jobs) {
  if (!useMongo) {
    const all = jsonReadJobs().filter(j => j.companyId !== companyId);
    jsonWriteJobs([...all, ...jobs]);
    return;
  }
  await connectDB();
  await Job.deleteMany({ companyId });
  if (jobs.length) await Job.insertMany(jobs);
}

// Adds jobs without wiping a company's existing ones, deduped by canonical
// link across the WHOLE collection (not per-company). replaceJobsForCompany
// stores under the company that was *searched*, which duplicated the same
// listing under every company whose search returned it — one listing was
// stored 113 times. Broad-search discovery stores under the company that
// actually posted the job, so this upsert is keyed on the link alone.
// Returns the number of genuinely new jobs inserted.
export async function upsertJobsByLink(jobs) {
  const canon = (l) => (l || '').split('?')[0];
  const incoming = [];
  const seen = new Set();
  for (const j of jobs) {
    const key = canon(j.link);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    incoming.push(j);
  }
  if (!incoming.length) return 0;

  if (!useMongo) {
    const all = jsonReadJobs();
    const existing = new Set(all.map(j => canon(j.link)));
    const fresh = incoming.filter(j => !existing.has(canon(j.link)));
    if (fresh.length) jsonWriteJobs([...all, ...fresh]);
    return fresh.length;
  }

  await connectDB();
  const links = incoming.map(j => canon(j.link));
  const existingDocs = await Job.find({ link: { $in: links } }, 'link').lean();
  const existing = new Set(existingDocs.map(d => canon(d.link)));
  const fresh = incoming.filter(j => !existing.has(canon(j.link)));
  if (fresh.length) await Job.insertMany(fresh, { ordered: false }).catch(() => {});
  return fresh.length;
}

export async function updateJob(jobId, companyId, update) {
  if (!useMongo) {
    const jobs = jsonReadJobs();
    const idx = jobs.findIndex(j => j.jobId === jobId && j.companyId === companyId);
    if (idx >= 0) Object.assign(jobs[idx], update);
    jsonWriteJobs(jobs);
    return;
  }
  await connectDB();
  return Job.findOneAndUpdate({ jobId, companyId }, { $set: update });
}

export async function updateCompanyScraped(companyId) {
  if (!useMongo) {
    const companies = jsonReadCompanies();
    const idx = companies.findIndex(c => c.id === companyId);
    if (idx >= 0) companies[idx].lastScraped = new Date().toISOString();
    jsonWriteCompanies(companies);
    return;
  }
  await connectDB();
  return Company.findOneAndUpdate({ id: companyId }, { lastScraped: new Date() });
}

// ── LinkedIn People ───────────────────────────────────────────────────────────
export async function readPeople(companyId) {
  if (!useMongo) {
    const all = jsonReadPeople();
    return companyId ? all.filter(p => p.companyId === companyId) : all;
  }
  await connectDB();
  const filter = companyId ? { companyId } : {};
  return LinkedInPerson.find(filter).lean().sort({ scrapedAt: -1 });
}

export async function savePeople(people) {
  if (!useMongo) {
    const existing = jsonReadPeople();
    const byUrl = new Map(existing.map(p => [p.profileUrl, p]));
    for (const p of people) {
      if (p.profileUrl) byUrl.set(p.profileUrl, { ...byUrl.get(p.profileUrl), ...p });
    }
    jsonWritePeople(Array.from(byUrl.values()));
    return;
  }
  await connectDB();
  for (const person of people) {
    if (!person.profileUrl) continue;
    await LinkedInPerson.findOneAndUpdate(
      { profileUrl: person.profileUrl },
      { $set: person },
      { upsert: true }
    ).catch(() => {});
  }
}

export async function markPersonConnected(profileUrl) {
  if (!useMongo) {
    const all = jsonReadPeople();
    const p = all.find(x => x.profileUrl === profileUrl);
    if (p) { p.connected = true; p.connectionSentAt = new Date().toISOString(); }
    jsonWritePeople(all);
    return;
  }
  await connectDB();
  return LinkedInPerson.findOneAndUpdate(
    { profileUrl },
    { connected: true, connectionSentAt: new Date() }
  );
}

// ── Applied Jobs ──────────────────────────────────────────────────────────────
export async function recordApplied(entries) {
  if (!useMongo) {
    const existing = jsonReadApplied();
    const byLink = new Map(existing.map(a => [a.jobLink, a]));
    for (const e of entries) {
      if (!byLink.has(e.jobLink)) byLink.set(e.jobLink, { ...e, appliedAt: new Date().toISOString() });
    }
    jsonWriteApplied(Array.from(byLink.values()));
    return;
  }
  await connectDB();
  for (const entry of entries) {
    await AppliedJob.findOneAndUpdate(
      { jobLink: entry.jobLink },
      { $setOnInsert: { ...entry, appliedAt: new Date() } },
      { upsert: true }
    ).catch(() => {});
  }
}

export async function readApplied() {
  if (!useMongo) return jsonReadApplied();
  await connectDB();
  return AppliedJob.find().lean().sort({ appliedAt: -1 });
}

// Same numbers readApplied() + a manual .length/group-by would produce, but
// via a server-side aggregation instead of pulling every applied-job document
// (1700+ and growing) over the wire just to count them — confirmed live this
// was a real contributor to /api/status taking 60s+ to respond.
export async function getAppliedCounts() {
  if (!useMongo) {
    const all = jsonReadApplied();
    const bySource = {};
    for (const a of all) bySource[a.source || 'unknown'] = (bySource[a.source || 'unknown'] || 0) + 1;
    return { total: all.length, bySource };
  }
  await connectDB();
  const rows = await AppliedJob.aggregate([{ $group: { _id: '$source', count: { $sum: 1 } } }]);
  const bySource = {};
  let total = 0;
  for (const r of rows) { bySource[r._id || 'unknown'] = r.count; total += r.count; }
  return { total, bySource };
}

// ── Skipped Jobs (permanently excluded from Easy Apply retries) ───────────────
export async function recordSkipped(entries) {
  // entries: [{ link, reason }]
  if (!useMongo) {
    const existing = jsonReadSkipped();
    const byLink = new Set(existing.map(s => s.link));
    for (const e of entries) {
      if (!byLink.has(e.link)) existing.push({ ...e, skippedAt: new Date().toISOString() });
    }
    jsonWriteSkipped(existing);
    return;
  }
  await connectDB();
  for (const entry of entries) {
    await SkippedJob.findOneAndUpdate(
      { link: entry.link },
      {
        // Reason and lastAttemptAt track the MOST RECENT outcome (a job that
        // failed differently this time should be judged on the new reason),
        // while skippedAt keeps the original sighting and attempts counts how
        // many times we've burned a slot on it.
        $set: { reason: entry.reason, lastAttemptAt: new Date() },
        $setOnInsert: { link: entry.link, skippedAt: new Date() },
        $inc: { attempts: 1 },
      },
      { upsert: true }
    ).catch(() => {});
  }
}

// Skip reasons that describe a TRANSIENT condition rather than a permanent
// property of the job, mapped to how long to wait before trying again.
// 'already-applied' and 'company-website' are deliberately absent: those are
// genuine terminal facts and must stay permanent.
export const RETRYABLE_SKIP_REASONS = {
  'no-apply-button': 3,
  'form-validation-error': 2,
  'no-submit-button-found': 2,
  'no-form-fields-found': 7,
  'job-timed-out': 1,
  'other': 3,
};
const MAX_SKIP_ATTEMPTS = 3;

// Links that should stay out of the apply queue right now. A retryable skip
// whose cooldown has elapsed and that is still under the attempt ceiling is
// intentionally NOT included, so it flows back into the queue.
export async function readActiveSkippedLinks() {
  const now = Date.now();
  const eligible = (d) => {
    const cooldownDays = RETRYABLE_SKIP_REASONS[d.reason];
    if (cooldownDays === undefined) return false;             // terminal reason — stays skipped
    if ((d.attempts || 1) >= MAX_SKIP_ATTEMPTS) return false; // exhausted — stays skipped
    const last = new Date(d.lastAttemptAt || d.skippedAt).getTime();
    return now - last >= cooldownDays * 86400000;
  };

  if (!useMongo) {
    return new Set(jsonReadSkipped().filter(d => !eligible(d)).map(s => s.link));
  }
  await connectDB();
  const docs = await SkippedJob.find({}, 'link reason attempts lastAttemptAt skippedAt').lean();
  return new Set(docs.filter(d => !eligible(d)).map(d => d.link));
}

// Jobs the automation couldn't finish but that are still real matches —
// CAPTCHA-gated, or a screening question the agent wouldn't guess at. These
// are recorded as skipped so runs don't loop on them, which also made them
// invisible; this surfaces them as a queue the user can finish by hand.
export async function readManualQueue(reasons = ['captcha-detected', 'captcha-detected-post-submit', 'needs-human-answer', 'no-submit-button-found', 'form-validation-error', 'captcha-security-code-required', 'resume-upload-failed']) {
  if (!useMongo) {
    return jsonReadSkipped()
      .filter(s => reasons.includes(s.reason))
      .sort((a, b) => new Date(b.skippedAt) - new Date(a.skippedAt));
  }
  await connectDB();
  const docs = await SkippedJob.find({ reason: { $in: reasons } }).lean().sort({ skippedAt: -1 });

  // Attach whatever we know about each job so the queue is readable.
  const links = docs.map(d => d.link);
  const jobs = await Job.find({ link: { $in: links } }, 'link title companyId').lean();
  const byLink = new Map(jobs.map(j => [j.link, j]));
  const companies = await Company.find({}, 'id name').lean();
  const nameById = new Map(companies.map(c => [c.id, c.name]));

  return docs.map(d => {
    const j = byLink.get(d.link);
    return {
      link: d.link,
      reason: d.reason,
      skippedAt: d.skippedAt,
      title: j?.title || null,
      companyName: j ? (nameById.get(j.companyId) || j.companyId) : null,
    };
  });
}

export async function readSkippedLinks() {
  if (!useMongo) return new Set(jsonReadSkipped().map(s => s.link));
  await connectDB();
  const docs = await SkippedJob.find({}, 'link').lean();
  return new Set(docs.map(d => d.link));
}

// ── Outreach Contacts ─────────────────────────────────────────────────────────
export async function readOutreachContacts() {
  if (!useMongo) return jsonReadOutreach();
  await connectDB();
  return OutreachContact.find().lean().sort({ discoveredAt: -1 });
}

// Same numbers readOutreachContacts() + manual .filter() counts would give,
// via a server-side aggregation instead of pulling every contact (4100+ and
// growing) over the wire just to count statuses.
export async function getOutreachCounts() {
  if (!useMongo) {
    const all = jsonReadOutreach();
    return {
      total: all.length,
      pending: all.filter(c => c.status === 'pending').length,
      sent: all.filter(c => c.status === 'sent').length,
      bounced: all.filter(c => c.status === 'bounced').length,
    };
  }
  await connectDB();
  const rows = await OutreachContact.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
  const byStatus = {};
  let total = 0;
  for (const r of rows) { byStatus[r._id || 'unknown'] = r.count; total += r.count; }
  return {
    total,
    pending: byStatus.pending || 0,
    sent: byStatus.sent || 0,
    bounced: byStatus.bounced || 0,
  };
}

export async function readOutreachEmails() {
  if (!useMongo) return new Set(jsonReadOutreach().map(c => c.email.toLowerCase()));
  await connectDB();
  const docs = await OutreachContact.find({}, 'email').lean();
  return new Set(docs.map(d => d.email.toLowerCase()));
}

export async function addOutreachContact(contact) {
  if (!useMongo) {
    const all = jsonReadOutreach();
    if (all.some(c => c.email.toLowerCase() === contact.email.toLowerCase())) return null;
    const entry = { ...contact, status: 'pending', discoveredAt: new Date().toISOString() };
    all.push(entry);
    jsonWriteOutreach(all);
    return entry;
  }
  await connectDB();
  try {
    return await OutreachContact.create({ ...contact, status: 'pending' });
  } catch {
    return null; // duplicate email
  }
}

// Escapes regex metacharacters (., +, *, ?, etc.) in a string so it can be used
// as a literal match inside a RegExp. Without this, "+"-tagged addresses (e.g.
// Gmail-style "name+tag@x.com", common on HN "who's hiring" contacts) silently
// fail to match `new RegExp('^'+email+'$')` — the "+" is read as a quantifier,
// not a literal character — so findOneAndUpdate matches zero documents and the
// status='sent' write never persists. The contact stays 'pending' forever and
// gets re-sent to on every subsequent cron run (confirmed: some addresses were
// re-sent 78+ times before this fix).
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function updateOutreachContact(email, update) {
  if (!useMongo) {
    const all = jsonReadOutreach();
    const idx = all.findIndex(c => c.email.toLowerCase() === email.toLowerCase());
    if (idx >= 0) Object.assign(all[idx], update);
    jsonWriteOutreach(all);
    return;
  }
  await connectDB();
  return OutreachContact.findOneAndUpdate({ email: new RegExp(`^${escapeRegex(email)}$`, 'i') }, { $set: update });
}

export async function deleteOutreachContact(email) {
  if (!useMongo) {
    const all = jsonReadOutreach().filter(c => c.email.toLowerCase() !== email.toLowerCase());
    jsonWriteOutreach(all);
    return;
  }
  await connectDB();
  return OutreachContact.deleteOne({ email: new RegExp(`^${escapeRegex(email)}$`, 'i') });
}

// ── Per-identity outreach settings (daily limit + automatic-sending switch) ──
export async function readIdentitySettings() {
  if (!useMongo) return [];
  await connectDB();
  return IdentitySettings.find().lean();
}

export async function getIdentitySettings(identityId) {
  if (!useMongo) return { identityId, dailyLimit: 150, autoSendEnabled: true };
  await connectDB();
  const doc = await IdentitySettings.findOne({ identityId }).lean();
  return doc || { identityId, dailyLimit: 150, autoSendEnabled: true };
}

export async function updateIdentitySettings(identityId, update) {
  if (!useMongo) return null;
  await connectDB();
  return IdentitySettings.findOneAndUpdate(
    { identityId },
    { $set: update, $setOnInsert: { identityId } },
    { upsert: true, new: true }
  ).lean();
}

// ── Screening-question answer cache ───────────────────────────────────────────
export async function readAnswerCache() {
  if (!useMongo) {
    const map = new Map();
    for (const a of jsonReadAnswers()) map.set(a.key, a.answer);
    return map;
  }
  await connectDB();
  const docs = await QuestionAnswer.find().lean();
  return new Map(docs.map(d => [d.key, d.answer]));
}

export async function saveAnswer({ key, question, answer, source }) {
  if (!useMongo) {
    const all = jsonReadAnswers();
    const idx = all.findIndex(a => a.key === key);
    if (idx >= 0) all[idx].usedCount = (all[idx].usedCount || 1) + 1;
    else all.push({ key, question, answer, source, usedCount: 1 });
    jsonWriteAnswers(all);
    return;
  }
  await connectDB();
  await QuestionAnswer.findOneAndUpdate(
    { key },
    { $set: { question, answer, source }, $inc: { usedCount: 1 } },
    { upsert: true }
  ).catch(() => {});
}

// ── Mail Insights ─────────────────────────────────────────────────────────────
export async function readMailInsights() {
  if (!useMongo) return jsonReadMailInsights();
  await connectDB();
  return MailInsight.find().lean().sort({ receivedAt: -1 });
}

export async function readMailInsightIds() {
  if (!useMongo) return new Set(jsonReadMailInsights().map(m => m.messageId));
  await connectDB();
  const docs = await MailInsight.find({}, 'messageId').lean();
  return new Set(docs.map(d => d.messageId));
}

export async function addMailInsight(insight) {
  if (!useMongo) {
    const all = jsonReadMailInsights();
    if (all.some(m => m.messageId === insight.messageId)) return null;
    const entry = { ...insight, scannedAt: new Date().toISOString() };
    all.push(entry);
    jsonWriteMailInsights(all);
    return entry;
  }
  await connectDB();
  try {
    return await MailInsight.create(insight);
  } catch {
    return null; // duplicate messageId
  }
}

// ── System State (generic key/value, e.g. alert cooldown timestamps) ──────────
export async function getSystemState(key) {
  if (!useMongo) return jsonReadSystemState()[key];
  await connectDB();
  const doc = await SystemState.findOne({ key }).lean();
  return doc?.value;
}

export async function setSystemState(key, value) {
  if (!useMongo) {
    const all = jsonReadSystemState();
    all[key] = value;
    jsonWriteSystemState(all);
    return;
  }
  await connectDB();
  await SystemState.findOneAndUpdate({ key }, { $set: { value } }, { upsert: true });
}


// ── ATS boards ────────────────────────────────────────────────────────────────
// Bulk upsert of directory/CDX entries. Uses $setOnInsert for identity fields
// so a re-sync can never clobber probe results already gathered for a board.
export async function upsertAtsBoards(boards) {
  if (!boards.length) return { inserted: 0 };
  await connectDB();
  const ops = boards.map(b => ({
    updateOne: {
      filter: { atsType: b.atsType, slug: b.slug },
      update: { $setOnInsert: { atsType: b.atsType, slug: b.slug, name: b.name, source: b.source || 'directory' } },
      upsert: true,
    },
  }));
  let inserted = 0;
  // Chunked: a single 12k-op bulkWrite exceeds the 16MB command limit.
  for (let i = 0; i < ops.length; i += 1000) {
    const res = await AtsBoard.bulkWrite(ops.slice(i, i + 1000), { ordered: false }).catch(() => null);
    inserted += res?.upsertedCount || 0;
  }
  return { inserted };
}

export async function recordBoardProbe(atsType, slug, { alive, jobCount = 0, error = null }) {
  await connectDB();
  await AtsBoard.updateOne(
    { atsType, slug },
    { $set: { alive, jobCount, lastProbedAt: new Date(), lastError: error } },
  ).catch(() => {});
}

// Bumps lastProbedAt only — deliberately separate from recordBoardProbe's
// alive/jobCount fields. readLiveBoards() sorts oldest-probed-first so a
// bounded sweep rotates across the whole set instead of exhausting the same
// slice every time, but that only works if something advances the timestamp
// after each sweep. It didn't: /api/portal-queue/refresh swept boards without
// ever touching lastProbedAt, so every run re-fetched the identical "oldest"
// N boards forever — confirmed in production by "newly queued" decaying to 0
// while ~70% of tracked boards had never been swept once.
export async function touchBoardsProbedAt(boards) {
  if (!boards.length) return;
  await connectDB();
  const now = new Date();
  const ops = boards.map(b => ({
    updateOne: {
      filter: { atsType: b.atsType, slug: b.slug },
      update: { $set: { lastProbedAt: now } },
    },
  }));
  for (let i = 0; i < ops.length; i += 1000) {
    await AtsBoard.bulkWrite(ops.slice(i, i + 1000), { ordered: false }).catch(() => {});
  }
}

// Boards still needing a liveness verdict, oldest-first so re-probes rotate.
export async function readUnprobedBoards({ limit = 5000, staleDays = null } = {}) {
  await connectDB();
  const or = [{ lastProbedAt: null }];
  if (staleDays) or.push({ lastProbedAt: { $lt: new Date(Date.now() - staleDays * 86400000) } });
  return AtsBoard.find({ $or: or }, 'atsType slug name').sort({ lastProbedAt: 1 }).limit(limit).lean();
}

// The apply queue's board source: confirmed-live boards that actually had
// postings when last probed.
export async function readLiveBoards({ atsTypes = null, limit = 20000, interleave = true } = {}) {
  await connectDB();
  const filter = { alive: true, jobCount: { $gt: 0 } };
  if (atsTypes) filter.atsType = { $in: atsTypes };
  const boards = await AtsBoard.find(filter, 'atsType slug name jobCount')
    .sort({ lastProbedAt: 1 }).limit(limit).lean();

  if (!interleave) return boards;

  // Round-robin across platforms instead of returning them in strict
  // lastProbedAt order.
  //
  // Sorting purely by probe age silently starved every newly-added platform:
  // Workable, Recruitee, Breezy and Teamtailor were probed last, so they
  // occupied positions 9,936+ of 13,385 and any sweep that didn't run to
  // completion never reached them. Confirmed in production — after 460 applies
  // the queue contained zero rows from all four, so the platforms added to
  // widen coverage were contributing nothing.
  //
  // Interleaving keeps the oldest-first rotation *within* each platform while
  // guaranteeing every platform is represented from the first board onward.
  const byType = new Map();
  for (const b of boards) {
    if (!byType.has(b.atsType)) byType.set(b.atsType, []);
    byType.get(b.atsType).push(b);
  }
  const queues = [...byType.values()];
  const out = [];
  for (let i = 0; out.length < boards.length; i++) {
    let progressed = false;
    for (const q of queues) {
      if (i < q.length) { out.push(q[i]); progressed = true; }
    }
    if (!progressed) break;
  }
  return out;
}

export async function atsBoardStats() {
  await connectDB();
  const rows = await AtsBoard.aggregate([
    { $group: { _id: { atsType: '$atsType', alive: '$alive' }, n: { $sum: 1 }, jobs: { $sum: '$jobCount' } } },
  ]);
  const out = {};
  for (const r of rows) {
    const t = r._id.atsType;
    out[t] = out[t] || { total: 0, live: 0, dead: 0, unprobed: 0, jobs: 0 };
    out[t].total += r.n;
    out[t].jobs += r.jobs || 0;
    if (r._id.alive === true) out[t].live += r.n;
    else if (r._id.alive === false) out[t].dead += r.n;
    else out[t].unprobed += r.n;
  }
  return out;
}


// ── Portal apply queue ────────────────────────────────────────────────────────
// $setOnInsert only: a posting already marked applied/skipped must never be
// reset to pending by the next discovery sweep finding it again.
export async function upsertPortalJobs(jobs) {
  if (!jobs.length) return { inserted: 0 };
  await connectDB();
  const ops = jobs.map(j => ({
    updateOne: {
      filter: { link: j.link },
      update: { $setOnInsert: { ...j, status: 'pending', discoveredAt: new Date() } },
      upsert: true,
    },
  }));
  let inserted = 0;
  for (let i = 0; i < ops.length; i += 1000) {
    const res = await PortalJob.bulkWrite(ops.slice(i, i + 1000), { ordered: false }).catch(() => null);
    inserted += res?.upsertedCount || 0;
  }
  return { inserted };
}

// Atomically hands out work. findOneAndUpdate per job rather than a find()
// then update, so two overlapping apply ticks can never claim the same
// posting and submit it twice.
export async function claimPortalJobs(limit = 50) {
  await connectDB();
  const claimed = [];
  for (let i = 0; i < limit; i++) {
    const doc = await PortalJob.findOneAndUpdate(
      { status: 'pending' },
      { $set: { status: 'in-progress', attemptedAt: new Date() }, $inc: { attempts: 1 } },
      { sort: { discoveredAt: 1 }, new: true }
    ).lean().catch(() => null);
    if (!doc) break;
    claimed.push(doc);
  }
  return claimed;
}

export async function markPortalJob(link, status, reason = null) {
  await connectDB();
  await PortalJob.updateOne({ link }, { $set: { status, reason } }).catch(() => {});
}

// A tick that dies mid-flight leaves rows stuck in-progress forever. Anything
// held longer than the per-job timeout could justify is returned to pending.
export async function releaseStalePortalJobs({ olderThanMinutes = 30 } = {}) {
  await connectDB();
  const res = await PortalJob.updateMany(
    { status: 'in-progress', attemptedAt: { $lt: new Date(Date.now() - olderThanMinutes * 60000) } },
    { $set: { status: 'pending' } }
  ).catch(() => null);
  return res?.modifiedCount || 0;
}

export async function portalQueueStats() {
  await connectDB();
  const rows = await PortalJob.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
  const out = { pending: 0, applied: 0, skipped: 0, 'in-progress': 0 };
  for (const r of rows) out[r._id] = r.n;
  return out;
}

// Applications submitted since local midnight, for the daily cap.
export async function countAppliedToday(source = null) {
  await connectDB();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const filter = { appliedAt: { $gte: start } };
  if (source) filter.source = source;
  return AppliedJob.countDocuments(filter);
}
