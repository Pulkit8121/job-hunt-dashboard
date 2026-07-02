import { NextResponse } from 'next/server';
import { readCompanies, addCompany } from '@/lib/db';
import { buildCompanyRecord, slugifyCompanyId } from '@/lib/company-utils';

export async function GET() {
  try {
    const companies = await readCompanies();
    return NextResponse.json(companies);
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    if (!body.name || !body.type || !body.workMode) {
      return NextResponse.json({ error: 'name, type, and workMode are required' }, { status: 400 });
    }

    const company = await addCompany(buildCompanyRecord({
      ...body,
      id: slugifyCompanyId(body.name),
      autoDiscovered: false,
      lastScraped: null,
    }));

    return NextResponse.json(company, { status: 201 });
  } catch (e) {
    const status = e.code === 11000 ? 409 : 500;
    return NextResponse.json({ error: e.code === 11000 ? 'Company already exists' : e.message }, { status });
  }
}
