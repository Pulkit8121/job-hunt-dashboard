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
  link:          String,
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
});

const OutreachContactSchema = new mongoose.Schema({
  companyId:    String,
  companyName:  { type: String, required: true },
  email:        { type: String, required: true, unique: true },
  source:       String,  // 'careers-page' | 'company-site' | 'search'
  confidence:   { type: String, default: 'medium' }, // 'high' | 'medium' | 'low'
  status:       { type: String, default: 'pending' }, // pending | sent | skipped | bounced
  sentAt:       Date,
  coverLetter:  String,
  replyStatus:  String,  // interested | rejected | auto-reply | other
  replySnippet: String,
  repliedAt:    Date,
  discoveredAt: { type: Date, default: Date.now },
}, { timestamps: true });

const MailInsightSchema = new mongoose.Schema({
  messageId: { type: String, required: true, unique: true },
  from:      String,
  subject:   String,
  snippet:   String,
  category:  String, // 'positive' | 'assessment' | 'rejected' | 'other'
  receivedAt:Date,
  scannedAt: { type: Date, default: Date.now },
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
export async function readJobs(companyId) {
  if (!useMongo) {
    const jobs = jsonReadJobs();
    const filtered = companyId ? jobs.filter(j => j.companyId === companyId) : jobs;
    return sortJobsBySource(filterEligibleJobs(filtered, Number.MAX_SAFE_INTEGER).eligible);
  }
  await connectDB();
  const filter = companyId ? { companyId } : {};
  const jobs = await Job.find(filter).lean();
  return sortJobsBySource(filterEligibleJobs(jobs, Number.MAX_SAFE_INTEGER).eligible);
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
      { $setOnInsert: { ...entry, skippedAt: new Date() } },
      { upsert: true }
    ).catch(() => {});
  }
}

// Jobs the automation couldn't finish but that are still real matches —
// CAPTCHA-gated, or a screening question the agent wouldn't guess at. These
// are recorded as skipped so runs don't loop on them, which also made them
// invisible; this surfaces them as a queue the user can finish by hand.
export async function readManualQueue(reasons = ['captcha-detected', 'captcha-detected-post-submit', 'needs-human-answer', 'no-submit-button-found', 'form-validation-error']) {
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

export async function updateOutreachContact(email, update) {
  if (!useMongo) {
    const all = jsonReadOutreach();
    const idx = all.findIndex(c => c.email.toLowerCase() === email.toLowerCase());
    if (idx >= 0) Object.assign(all[idx], update);
    jsonWriteOutreach(all);
    return;
  }
  await connectDB();
  return OutreachContact.findOneAndUpdate({ email: new RegExp(`^${email}$`, 'i') }, { $set: update });
}

export async function deleteOutreachContact(email) {
  if (!useMongo) {
    const all = jsonReadOutreach().filter(c => c.email.toLowerCase() !== email.toLowerCase());
    jsonWriteOutreach(all);
    return;
  }
  await connectDB();
  return OutreachContact.deleteOne({ email: new RegExp(`^${email}$`, 'i') });
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
