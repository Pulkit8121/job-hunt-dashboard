'use client';
import { useState, useEffect, useCallback } from 'react';
import { Globe2, X, Briefcase } from 'lucide-react';

export default function CompanyPortalPanel({ streamScrape, busy }) {
  const [applied, setApplied] = useState([]);
  const [manual, setManual] = useState([]);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [appliedRes, manualRes] = await Promise.all([
        fetch('/api/applied').then(r => r.json()).catch(() => []),
        fetch('/api/manual-queue').then(r => r.json()).catch(() => []),
      ]);
      setApplied(Array.isArray(appliedRes) ? appliedRes.filter(a => a.source === 'company-portal') : []);
      setManual(Array.isArray(manualRes) ? manualRes : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleApply() {
    setApplying(true);
    try {
      await streamScrape('/api/company-portal-apply', {}, 'Scanning Greenhouse/Lever/Ashby companies and applying...');
    } finally {
      setApplying(false);
      await load();
    }
  }

  async function handleStop() {
    try { await fetch('/api/company-portal-apply/stop', { method: 'POST' }); } catch {}
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-indigo-700/40 bg-indigo-900/10 p-5 space-y-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-bold text-indigo-200 flex items-center gap-2">
              <Globe2 size={14} /> Company Portal Auto-Apply
            </h2>
            <p className="text-xs text-indigo-100/60 mt-1">
              Scans companies tagged with a Greenhouse, Lever, or Ashby job board, applies globally (any city, remote worldwide, US remote tech — sponsorship answered honestly on each form), and tailors a short answer per open-ended question via AI. Workday listings are discovered but logged for manual apply — that flow needs account creation per company and isn&apos;t automated yet. Applications that hit a CAPTCHA are skipped and logged, never auto-solved.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={handleApply} disabled={busy || applying}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500
                text-white font-bold text-sm transition-colors disabled:opacity-40 shadow-lg">
              <Globe2 size={14} className={applying ? 'animate-pulse' : ''} />
              {applying ? 'Applying...' : 'Apply on Company Portals'}
            </button>
            {applying && (
              <button onClick={handleStop}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500
                  text-white font-bold text-sm transition-colors shadow-lg">
                <X size={14} /> Stop
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-6">
        <div>
          <p className="text-lg font-bold text-indigo-300">{applied.length}</p>
          <p className="text-xs text-[#8b949e]">Portal applications</p>
        </div>
        <div>
          <p className="text-lg font-bold text-amber-300">{manual.length}</p>
          <p className="text-xs text-[#8b949e]">Need manual apply</p>
        </div>
      </div>

      {manual.length > 0 && (
        <div className="rounded-xl border border-amber-700/40 bg-amber-900/10 p-5">
          <h3 className="text-sm font-bold text-amber-200 mb-1">Finish these by hand ({manual.length})</h3>
          <p className="text-xs text-amber-100/60 mb-3">
            Real matches the automation couldn&apos;t submit — a CAPTCHA, a screening question it wouldn&apos;t guess at, or a form it couldn&apos;t read. Your details are already in the profile, so these are usually a couple of minutes each.
          </p>
          <div className="max-h-80 overflow-y-auto rounded-lg border border-[#30363d] bg-[#0d1117]">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-[#21262d]">
                {manual.map((m) => (
                  <tr key={m.link}>
                    <td className="px-3 py-2 text-[#e6edf3]">{m.title || '(job)'}</td>
                    <td className="px-3 py-2 text-[#8b949e]">{m.companyName || ''}</td>
                    <td className="px-3 py-2">
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-amber-700/40 text-amber-300">
                        {m.reason?.startsWith('captcha') ? 'CAPTCHA' : m.reason === 'needs-human-answer' ? 'question' : m.reason}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <a href={m.link} target="_blank" rel="noopener noreferrer"
                        className="text-xs text-indigo-300 hover:text-indigo-200">Open ↗</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-[#8b949e]">Loading applications...</p>
      ) : applied.length === 0 ? (
        <div className="text-center py-16 text-[#8b949e]">
          <Briefcase size={40} className="mx-auto mb-4 opacity-20" />
          <p className="text-sm">No company-portal applications yet.</p>
          <p className="text-xs mt-2 opacity-60">Tag companies with an ATS (Greenhouse/Lever/Ashby) in Add Company, then click &quot;Apply on Company Portals&quot;.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-[#30363d] bg-[#161b22] overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#30363d] text-left text-xs text-[#8b949e]">
                <th className="px-4 py-2 font-medium">Company</th>
                <th className="px-4 py-2 font-medium">Job</th>
                <th className="px-4 py-2 font-medium">Applied</th>
                <th className="px-4 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#21262d]">
              {applied.map((a) => (
                <tr key={a.jobLink}>
                  <td className="px-4 py-2 text-[#e6edf3]">{a.companyName}</td>
                  <td className="px-4 py-2 text-[#8b949e]">{a.jobTitle}</td>
                  <td className="px-4 py-2 text-[#8b949e]">{a.appliedAt ? new Date(a.appliedAt).toLocaleDateString() : ''}</td>
                  <td className="px-4 py-2 text-right">
                    <a href={a.jobLink} target="_blank" rel="noopener noreferrer" className="text-[#8b949e] hover:text-indigo-400 transition-colors text-xs">
                      View ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
