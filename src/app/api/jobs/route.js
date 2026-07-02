import { NextResponse } from 'next/server';
import { readJobs } from '@/lib/db';

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const companyId = searchParams.get('companyId') || null;
    const jobs = await readJobs(companyId);
    return NextResponse.json(jobs);
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
