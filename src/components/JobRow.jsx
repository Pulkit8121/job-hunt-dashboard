'use client';
import { ExternalLink, MapPin, Zap } from 'lucide-react';

function getSourceMeta(source) {
  if (source === 'career-agent' || source === 'careers-page') {
    return {
      label: 'Company Site',
      actionLabel: 'Apply on site',
      color: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/40',
      priority: true,
    };
  }
  if (source === 'naukri') {
    return {
      label: 'Naukri',
      actionLabel: 'Open on Naukri',
      color: 'bg-amber-900/40 text-amber-300 border-amber-700/40',
      priority: false,
    };
  }
  if (source === 'wellfound') {
    return {
      label: 'Wellfound',
      actionLabel: 'Open on Wellfound',
      color: 'bg-blue-900/40 text-blue-300 border-blue-700/40',
      priority: false,
    };
  }
  return {
    label: source || 'unknown',
    actionLabel: 'Open link',
    color: 'bg-[#21262d] text-[#8b949e] border-[#30363d]',
    priority: false,
  };
}

function ScoreBadge({ score, tier }) {
  const color = tier === 'high'
    ? 'bg-emerald-900/60 text-emerald-300 border-emerald-700/40'
    : tier === 'medium'
    ? 'bg-yellow-900/60 text-yellow-300 border-yellow-700/40'
    : 'bg-red-900/60 text-red-300 border-red-700/40';
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border font-mono ${color}`}>
      {score}%
    </span>
  );
}

export default function JobRow({ job }) {
  const sourceMeta = getSourceMeta(job.source);

  return (
    <div className={`flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-white/5 transition-colors group ${
      sourceMeta.priority ? 'border-l-2 border-emerald-700/60' : ''
    }`}>
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
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          {job.location && (
            <span className="flex items-center gap-1 text-xs text-[#8b949e]">
              <MapPin size={10} /> {job.location}
            </span>
          )}
          {job.experienceText && (
            <span className="text-xs text-[#8b949e] bg-[#21262d] px-1.5 py-0.5 rounded">
              {job.experienceText}
            </span>
          )}
          {job.matchedSkills?.slice(0, 3).map(s => (
            <span key={s} className="text-xs text-[#8b949e] bg-[#21262d] px-1.5 py-0.5 rounded">
              {s}
            </span>
          ))}
        </div>
        {job.aiSummary && (
          <p className="text-xs text-[#8b949e] mt-0.5 italic truncate">{job.aiSummary}</p>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <ScoreBadge score={job.matchScore} tier={job.matchTier} />
        <span className={`text-xs border px-2 py-0.5 rounded ${sourceMeta.color}`}>
          {sourceMeta.label}
        </span>
        {job.link ? (
          <a
            href={job.link}
            target="_blank"
            rel="noopener noreferrer"
            className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium
              transition-colors border ${
                sourceMeta.priority
                  ? 'bg-emerald-900/40 hover:bg-emerald-900/60 text-emerald-200 border-emerald-700/50'
                  : 'bg-[#21262d] hover:bg-[#30363d] text-[#e6edf3] border-[#30363d]'
              }`}
          >
            {sourceMeta.actionLabel} <ExternalLink size={10} />
          </a>
        ) : (
          <span className="text-xs text-[#8b949e] italic">No link</span>
        )}
      </div>
    </div>
  );
}
