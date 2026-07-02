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

const Company       = mongoose.models.Company       || mongoose.model('Company',       CompanySchema);
const Job           = mongoose.models.Job           || mongoose.model('Job',           JobSchema);
const LinkedInPerson= mongoose.models.LinkedInPerson|| mongoose.model('LinkedInPerson',LinkedInPersonSchema);
const AppliedJob    = mongoose.models.AppliedJob    || mongoose.model('AppliedJob',    AppliedJobSchema);
const SkippedJob    = mongoose.models.SkippedJob    || mongoose.model('SkippedJob',    SkippedJobSchema);

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

export async function readSkippedLinks() {
  if (!useMongo) return new Set(jsonReadSkipped().map(s => s.link));
  await connectDB();
  const docs = await SkippedJob.find({}, 'link').lean();
  return new Set(docs.map(d => d.link));
}
