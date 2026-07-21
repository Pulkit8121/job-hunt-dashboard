'use client';
import { useMemo, useState } from 'react';
import { ExternalLink, MapPin, Search, Zap } from 'lucide-react';

const SOURCE_META = {
  'career-agent':  { label: 'Company Site', color: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/40' },
  'careers-page':  { label: 'Company Site', color: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/40' },
  naukri:          { label: 'Naukri',        color: 'bg-amber-900/40 text-amber-300 border-amber-700/40' },
  wellfound:       { label: 'Wellfound',     color: 'bg-blue-900/40 text-blue-300 border-blue-700/40' },
};

function sourceMeta(source) {
  return SOURCE_META[source] || { label: source || 'unknown', color: 'bg-[#21262d] text-[#8b949e] border-[#30363d]' };
}

function scoreBadgeColor(tier) {
  if (tier === 'high') return 'bg-emerald-900/60 text-emerald-300 border-emerald-700/40';
  if (tier === 'medium') return 'bg-yellow-900/60 text-yellow-300 border-yellow-700/40';
  return 'bg-red-900/60 text-red-300 border-red-700/40';
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

const PAGE_SIZE = 100;

export default function RecentJobsPanel({ jobs, companies }) {
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const companyMap = useMemo(
    () => Object.fromEntries((companies || []).map(c => [c.id, c.name])),
    [companies]
  );

  const sorted = useMemo(() => {
    return [...(jobs || [])]
      .filter(j => j.postedDate)
      .sort((a, b) => new Date(b.postedDate) - new Date(a.postedDate));
  }, [jobs]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(j => {
      const companyName = companyMap[j.companyId] || j.companyId || '';
      return j.title?.toLowerCase().includes(q) || companyName.toLowerCase().includes(q);
    });
  }, [sorted, search, companyMap]);

  const visible = filtered.slice(0, visibleCount);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-4">
          <div>
            <p className="text-lg font-bold text-sky-300">{sorted.length}</p>
            <p className="text-xs text-[#8b949e]">Total jobs tracked</p>
          </div>
          <div>
            <p className="text-lg font-bold text-emerald-300">
              {sorted.filter(j => timeAgo(j.postedDate) === 'today' || timeAgo(j.postedDate) === '1d ago').length}
            </p>
            <p className="text-xs text-[#8b949e]">Posted in last 2 days</p>
          </div>
        </div>
        <div className="relative w-full sm:w-72">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8b949e]" />
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setVisibleCount(PAGE_SIZE); }}
            placeholder="Filter by title or company..."
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#161b22] border border-[#30363d] text-sm text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-sky-600"
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="text-center py-16 text-[#8b949e]">
          <Search size={40} className="mx-auto mb-4 opacity-20" />
          <p className="text-sm">No jobs match.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-[#30363d] bg-[#161b22] divide-y divide-[#21262d] overflow-hidden">
          {visible.map((job) => {
            const meta = sourceMeta(job.source);
            const companyName = companyMap[job.companyId] || job.companyId;
            return (
              <div key={`${job.companyId}-${job.jobId || job.link}`}
                className="flex items-center gap-3 py-2.5 px-4 hover:bg-white/5 transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-[#e6edf3] truncate">{job.title}</p>
                    {job.isEasyApply && (
                      <span className="shrink-0 flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded
                        bg-yellow-900/40 text-yellow-300 border border-yellow-700/40 font-medium">
                        <Zap size={9} /> Easy Apply
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap text-xs text-[#8b949e]">
                    <span className="text-[#e6edf3]/80">{companyName}</span>
                    {job.location && (
                      <span className="flex items-center gap-1">
                        <MapPin size={10} /> {job.location}
                      </span>
                    )}
                    <span>{timeAgo(job.postedDate)}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {typeof job.matchScore === 'number' && (
                    <span className={`text-xs px-2 py-0.5 rounded-full border font-mono ${scoreBadgeColor(job.matchTier)}`}>
                      {job.matchScore}%
                    </span>
                  )}
                  <span className={`text-xs border px-2 py-0.5 rounded ${meta.color}`}>{meta.label}</span>
                  {job.link ? (
                    <a href={job.link} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium
                        bg-[#21262d] hover:bg-[#30363d] text-[#e6edf3] border border-[#30363d] transition-colors">
                      View <ExternalLink size={10} />
                    </a>
                  ) : (
                    <span className="text-xs text-[#8b949e] italic">No link</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {visibleCount < filtered.length && (
        <div className="flex justify-center">
          <button onClick={() => setVisibleCount(v => v + PAGE_SIZE)}
            className="px-4 py-2 rounded-lg bg-[#21262d] hover:bg-[#30363d] text-sm text-[#8b949e] hover:text-[#e6edf3] border border-[#30363d] transition-colors">
            Load {Math.min(PAGE_SIZE, filtered.length - visibleCount)} more
          </button>
        </div>
      )}
    </div>
  );
}
