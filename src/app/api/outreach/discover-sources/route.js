export const maxDuration = 600;
export const dynamic = 'force-dynamic';

import {
  readCompanies, updateCompany, addCompany,
  readOutreachEmails, addOutreachContact,
} from '@/lib/db';
import { mineCompany, rateLimit } from '@/lib/email-sources/github-miner';
import { fetchMcaCompanies } from '@/lib/email-sources/mca-india';
import { fetchProductHuntMakers } from '@/lib/email-sources/producthunt';
import { generateCandidates, domainAcceptsMail, inferPattern } from '@/lib/email-sources/pattern-generator';
import { buildCompanyRecord, slugifyCompanyId } from '@/lib/company-utils';
import { isExcludedCompany, getExcludedCompanies, isExcludedOutreachDomain } from '@/lib/exclusions';
import { startRun, finishRun, isRunning } from '@/lib/emailSourcesRunState';

function domainFromCompany(company) {
  for (const url of [company.careersUrl, company.websiteUrl]) {
    if (!url) continue;
    try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch {}
  }
  return null;
}

export async function POST(request) {
  const {
    sources = ['github', 'mca', 'producthunt'],
    githubLimit = 40,
    mcaPages = 20,
    phPages = 3,
    guessFromPatterns = false,
  } = await request.json().catch(() => ({}));

  const encoder = new TextEncoder();
  const stream  = new TransformStream();
  const writer  = stream.writable.getWriter();
  const send    = (msg) => writer.write(encoder.encode(`data: ${JSON.stringify({ message: msg })}\n\n`)).catch(() => {});

  if (isRunning()) {
    await send('⚠ An email-source discovery run is already in progress.');
    await writer.close().catch(() => {});
    return new Response(stream.readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
    });
  }
  const controller = startRun();
  const signal = controller.signal;

  (async () => {
    let saved = 0;
    let patternsLearned = 0;
    try {
      const known = await readOutreachEmails();
      const excluded = getExcludedCompanies();

      const persist = async ({ companyId, companyName, email, source, confidence }) => {
        const e = (email || '').toLowerCase();
        if (!e || known.has(e) || isExcludedOutreachDomain(e)) return false;
        const rec = await addOutreachContact({ companyId, companyName, email: e, source, confidence }).catch(() => null);
        if (rec) { known.add(e); saved++; return true; }
        return false;
      };

      // ── 1. GitHub commit mining ────────────────────────────────────────────
      if (sources.includes('github')) {
        const rl = await rateLimit().catch(() => null);
        await send(`🐙 GitHub: ${rl?.authenticated ? 'authenticated (5000/hr)' : 'UNAUTHENTICATED — only 60 req/hr, set GITHUB_TOKEN for 5000/hr'}. Core remaining: ${rl?.core?.remaining ?? '?'}`);

        const companies = (await readCompanies())
          .filter(c => !isExcludedCompany(c.name, excluded))
          .filter(c => !c.emailPattern) // skip ones already solved
          .slice(0, githubLimit);

        await send(`🐙 Mining commits for up to ${companies.length} company(s)...`);
        let hitCompanies = 0;

        for (const company of companies) {
          if (signal.aborted) break;
          const domain = domainFromCompany(company);
          let res;
          try {
            res = await mineCompany(company.name, domain, { maxRepos: 3, commitsPerRepo: 100 });
          } catch (e) {
            if (e.rateLimited) { await send('⚠ GitHub rate limit reached — stopping this source.'); break; }
            continue;
          }
          if (!res.org) continue;
          hitCompanies++;

          for (const hit of res.corporate) {
            if (await persist({
              companyId: company.id, companyName: company.name,
              email: hit.email, source: 'github-commit', confidence: 'high',
            })) {
              await send(`✓ ${company.name} → ${hit.email}${hit.name ? ` (${hit.name})` : ''}`);
            }
          }

          const update = { githubOrg: res.org };
          if (res.inferredPattern) { update.emailPattern = res.inferredPattern; patternsLearned++; }
          await updateCompany(company.id, update).catch(() => {});
          if (res.inferredPattern) {
            await send(`🔑 ${company.name}: email format is "${res.inferredPattern}" — can now address anyone there by name.`);
          }
        }
        await send(`🐙 GitHub done: ${hitCompanies} org(s) matched, ${patternsLearned} email format(s) learned.`);
      }

      // ── 2. MCA India (data.gov.in) ─────────────────────────────────────────
      if (sources.includes('mca') && !signal.aborted) {
        await send('🇮🇳 MCA Company Master Data (Karnataka, IT-classified, active only)...');
        const rows = await fetchMcaCompanies({
          state: 'karnataka', limit: 1000, maxPages: mcaPages,
          itOnly: true, activeOnly: true, onProgress: send,
        }).catch(async (e) => { await send(`⚠ MCA: ${e.message}`); return []; });

        for (const row of rows) {
          if (signal.aborted) break;
          if (isExcludedCompany(row.companyName, excluded)) continue;
          const id = slugifyCompanyId(row.companyName);
          if (id) {
            await addCompany(buildCompanyRecord({
              id, name: row.companyName, locations: ['Bengaluru'], autoDiscovered: true,
            })).catch(() => {});
          }
          // Registered-office address: a real contact, but often the company's
          // accountant rather than a recruiter — hence low confidence.
          await persist({
            companyId: id, companyName: row.companyName,
            email: row.email, source: 'mca-india', confidence: 'low',
          });
        }
        await send(`🇮🇳 MCA done: ${rows.length} IT company row(s) with usable emails.`);
      }

      // ── 3. Product Hunt founders ───────────────────────────────────────────
      if (sources.includes('producthunt') && !signal.aborted) {
        await send('🚀 Product Hunt makers (early-stage founders)...');
        const makers = await fetchProductHuntMakers({ pages: phPages, onProgress: send });

        for (const maker of makers) {
          if (signal.aborted) break;
          if (isExcludedCompany(maker.companyName, excluded)) continue;
          if (!(await domainAcceptsMail(maker.domain))) continue;

          // Product Hunt exposes the maker but not their address, so try to
          // resolve it: real emails from the company's public commits first,
          // then a pattern-based construction.
          const mined = await mineCompany(maker.companyName, maker.domain, { maxRepos: 2 }).catch(() => null);
          const id = slugifyCompanyId(maker.companyName);

          if (mined?.corporate?.length) {
            for (const hit of mined.corporate) {
              if (await persist({
                companyId: id, companyName: maker.companyName,
                email: hit.email, source: 'producthunt+github', confidence: 'high',
              })) await send(`✓ ${maker.companyName} → ${hit.email}`);
            }
            continue;
          }

          if (!guessFromPatterns) continue;
          const pattern = mined?.inferredPattern || null;
          const [best] = generateCandidates({
            fullName: maker.founderName, domain: maker.domain,
            knownPattern: pattern, headcount: 50, limit: 1,
          });
          if (best && await persist({
            companyId: id, companyName: maker.companyName,
            email: best.email, source: `pattern:${best.pattern}`, confidence: 'low',
          })) {
            await send(`≈ ${maker.companyName} → ${best.email} (constructed, unverified)`);
          }
        }
        await send(`🚀 Product Hunt done: ${makers.length} maker(s) processed.`);
      }

      await send(
        signal.aborted
          ? `STOPPED: ${saved} new contact(s) saved before stopping.`
          : `DONE: ${saved} new contact(s) saved. ${patternsLearned} company email format(s) learned.`
      );
    } catch (e) {
      await send(`FATAL: ${e.message}`);
    } finally {
      finishRun();
      await writer.close().catch(() => {});
    }
  })();

  return new Response(stream.readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
  });
}
