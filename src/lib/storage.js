import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');

export function readCompanies() {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'companies.json'), 'utf-8'));
}

export function writeCompanies(companies) {
  fs.writeFileSync(path.join(DATA_DIR, 'companies.json'), JSON.stringify(companies, null, 2));
}

export function readJobs() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'jobs.json'), 'utf-8'));
  } catch {
    return [];
  }
}

export function writeJobs(jobs) {
  fs.writeFileSync(path.join(DATA_DIR, 'jobs.json'), JSON.stringify(jobs, null, 2));
}
