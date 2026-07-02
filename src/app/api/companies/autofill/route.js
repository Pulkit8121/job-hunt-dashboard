import { NextResponse } from 'next/server';
import { readCompanies } from '@/lib/db';
import { buildCompanyRecord, slugifyCompanyId } from '@/lib/company-utils';

export async function POST(request) {
  try {
    const body = await request.json();
    const name = String(body.name || '').trim();

    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    const companyId = slugifyCompanyId(name);
    const companies = await readCompanies();
    const existing = companies.find(company =>
      company.id === companyId || company.name.toLowerCase().trim() === name.toLowerCase()
    );

    if (existing) {
      return NextResponse.json({
        company: buildCompanyRecord(existing),
        existing: true,
        message: `${existing.name} already exists in the dashboard. Review the values before creating a duplicate.`,
      });
    }

    return NextResponse.json({
      company: buildCompanyRecord({ name }),
      existing: false,
      message: 'Filled common defaults from the company name. Review type, work mode, and interview level before saving.',
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
