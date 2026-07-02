'use client';
import { useState } from 'react';
import { RefreshCw, ChevronDown, ChevronUp, MapPin, ExternalLink, Search, CheckCircle2, AlertCircle, Bot } from 'lucide-react';
import JobRow from './JobRow';
import LinkedInPanel from './LinkedInPanel';

const TYPE_BADGE = {
  'easy-mnc':   'bg-blue-900/50 text-blue-300 border-blue-700/40',
  'remote-mnc': 'bg-purple-900/50 text-purple-300 border-purple-700/40',
  hard:         'bg-red-900/50 text-red-300 border-red-700/40',
  startup:      'bg-orange-900/50 text-orange-300 border-orange-700/40',
  unknown:      'bg-gray-700/50 text-gray-300 border-gray-600/40',
};
const TYPE_LABEL = { 'easy-mnc': 'Easy MNC', 'remote-mnc': 'Remote MNC', hard: 'Hard', startup: 'Startup', unknown: 'Unknown' };

const WORK_BADGE = {
  remote:  'bg-emerald-900/40 text-emerald-300 border-emerald-700/40',
  hybrid:  'bg-indigo-900/40 text-indigo-300 border-indigo-700/40',
  onsite:  'bg-amber-900/40 text-amber-300 border-amber-700/40',
  unknown: 'bg-gray-700/40 text-gray-400 border-gray-600/40',
};

const DIFF_BADGE = {
  easy:     'text-emerald-400',
  moderate: 'text-yellow-400',
  hard:     'text-red-400',
};

function timeAgo(iso) {
  if (!iso) return null;
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3600000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function CompanyCard({
  company,
  jobs,
  linkedInTargets,
  linkedInPeople = [],
  onRefresh,
  onAgentRefresh,
  refreshDisabled = false,
  focusTier = 'all',
}) {
  const [expanded, setExpanded] = useState(false);
  const [showLow, setShowLow]   = useState(false);
  const [scraping, setScraping] = useState(false);
  const [agentScraping, setAgentScraping] = useState(false);

  const highJobs   = jobs.filter(j => j.matchTier === 'high');
  const mediumJobs = jobs.filter(j => j.matchTier === 'medium');
  const lowJobs    = jobs.filter(j => j.matchTier === 'low');
  const scrapedAgo = timeAgo(company.lastScraped);
  const isScanned  = !!company.lastScraped;
  const jobsWithLinks = jobs.filter(j => j.link);

  function openAllJobs(e) {
    e.stopPropagation();
    jobsWithLinks.forEach(j => window.open(j.link, '_blank', 'noopener,noreferrer'));
  }

  async function handleRefresh(e) {
    e.stopPropagation();
    setScraping(true);
    await onRefresh(company.id);
    setScraping(false);
  }

  async function handleAgentRefresh(e) {
    e.stopPropagation();
    if (!onAgentRefresh) return;
    setAgentScraping(true);
    await onAgentRefresh(company.id);
    setAgentScraping(false);
  }

  return (
    <div className={`rounded-xl border flex flex-col overflow-hidden transition-colors ${
      isScanned ? 'border-[#30363d] bg-[#161b22]' : 'border-[#21262d] bg-[#0d1117]'
    }`}>
      {/* Header */}
      <div className="p-4 cursor-pointer hover:bg-white/[0.02] transition-colors" onClick={() => setExpanded(e => !e)}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            {/* Name + badges row */}
            <div className="flex items-center gap-2 flex-wrap">
              {isScanned
                ? <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />
                : <AlertCircle  size={13} className="text-[#484f58] shrink-0" />
              }
              <h3 className="font-semibold text-[#e6edf3] text-sm leading-tight">{company.name}</h3>
              <span className={`text-xs px-2 py-0.5 rounded-full border ${WORK_BADGE[company.workMode]}`}>
                {company.workMode}
              </span>
              <span className={`text-xs px-2 py-0.5 rounded-full border ${TYPE_BADGE[company.type]}`}>
                {TYPE_LABEL[company.type]}
              </span>
              <span className={`text-xs px-2 py-0.5 rounded-full border ${
                isScanned
                  ? 'bg-emerald-900/30 text-emerald-300 border-emerald-700/40'
                  : 'bg-[#21262d] text-[#8b949e] border-[#30363d]'
              }`}>
                {isScanned ? 'Scanned' : 'Pending scan'}
              </span>
              {company.autoDiscovered && (
                <span className="text-xs px-2 py-0.5 rounded-full border bg-yellow-900/30 text-yellow-300 border-yellow-700/40">
                  Auto added
                </span>
              )}
            </div>

            {/* Meta row */}
            <div className="flex items-center gap-3 mt-1.5 flex-wrap">
              <span className="flex items-center gap-1 text-xs text-[#8b949e]">
                <MapPin size={10} /> {company.locations?.join(', ')}
              </span>
              <span className="text-xs text-[#8b949e]">{company.salaryRange}</span>
              {company.difficulty && (
                <span className={`text-xs font-medium ${DIFF_BADGE[company.difficulty]}`}>
                  {company.difficulty === 'easy' ? '✓ Interview: easy' :
                   company.difficulty === 'moderate' ? '~ Interview: moderate' : '⚡ Interview: hard'}
                </span>
              )}
            </div>

            {/* Interview note */}
            {company.interviewNote && (
              <p className="text-xs text-[#8b949e] mt-1 italic leading-tight">{company.interviewNote}</p>
            )}

            {/* Scanned info + job count */}
            <div className="flex items-center gap-3 mt-1.5">
              {scrapedAgo
                ? <span className="text-xs text-emerald-600">Scanned {scrapedAgo}</span>
                : <span className="text-xs text-[#484f58]">Not scanned yet</span>
              }
              {jobs.length > 0 && (
                <span className="text-xs font-semibold text-emerald-400">{jobs.length} job{jobs.length !== 1 ? 's' : ''} found</span>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={handleAgentRefresh}
              disabled={agentScraping || scraping || refreshDisabled}
              className="p-1.5 rounded-md hover:bg-[#21262d] text-fuchsia-300 hover:text-fuchsia-100 transition-colors disabled:opacity-40"
              title="Agent scan this company with career-site-first priority"
            >
              <Bot size={13} className={agentScraping ? 'animate-pulse' : ''} />
            </button>
            <button
              onClick={handleRefresh}
              disabled={agentScraping || scraping || refreshDisabled}
              className="p-1.5 rounded-md hover:bg-[#21262d] text-[#8b949e] hover:text-[#e6edf3] transition-colors disabled:opacity-40"
              title="Scan this company"
            >
              <RefreshCw size={13} className={scraping ? 'animate-spin' : ''} />
            </button>
            {expanded ? <ChevronUp size={14} className="text-[#8b949e]" /> : <ChevronDown size={14} className="text-[#8b949e]" />}
          </div>
        </div>

        {/* Career page + Naukri quick-links always visible */}
        <div className="flex items-center gap-2 mt-2.5 flex-wrap" onClick={e => e.stopPropagation()}>
          {company.careersUrl && (
            <a
              href={company.careersUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium
                bg-[#21262d] hover:bg-[#30363d] text-[#e6edf3] border border-[#30363d] transition-colors"
            >
              <ExternalLink size={11} /> Career Page
            </a>
          )}
          {company.naukriSearchUrl && (
            <a
              href={company.naukriSearchUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium
                bg-[#21262d] hover:bg-[#30363d] text-[#8b949e] hover:text-[#e6edf3] border border-[#30363d] transition-colors"
            >
              <Search size={11} /> Naukri
            </a>
          )}
          {company.wellfoundUrl && (
            <a
              href={company.wellfoundUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium
                bg-[#21262d] hover:bg-[#30363d] text-[#8b949e] hover:text-[#e6edf3] border border-[#30363d] transition-colors"
            >
              <ExternalLink size={11} /> Wellfound
            </a>
          )}
          {jobsWithLinks.length > 0 && (
            <button
              onClick={openAllJobs}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium
                bg-emerald-900/40 hover:bg-emerald-900/60 text-emerald-300 border border-emerald-700/40 transition-colors"
              title={`Open all ${jobsWithLinks.length} job listings in new tabs`}
            >
              <ExternalLink size={11} /> Open {jobsWithLinks.length} job{jobsWithLinks.length !== 1 ? 's' : ''}
            </button>
          )}
        </div>
      </div>

      {/* Expanded jobs + LinkedIn */}
      {expanded && (
        <div className="border-t border-[#30363d] px-4 pb-4 pt-3">
          {jobs.length === 0 && (
            <p className="text-sm text-[#8b949e] italic text-center py-3">
              No jobs found yet — click ↺ to scan this company.
            </p>
          )}

          {highJobs.length > 0 && (
            <div className="mb-3">
              <p className="text-xs font-semibold text-emerald-400 mb-1.5">● High Match ({highJobs.length})</p>
              {highJobs.map(j => <JobRow key={j.jobId + j.companyId} job={j} />)}
            </div>
          )}

          {mediumJobs.length > 0 && (
            <div className="mb-3">
              <p className="text-xs font-semibold text-yellow-400 mb-1.5">● Medium Match ({mediumJobs.length})</p>
              {mediumJobs.map(j => <JobRow key={j.jobId + j.companyId} job={j} />)}
            </div>
          )}

          {lowJobs.length > 0 && focusTier === 'low' && (
            <div>
              <p className="text-xs font-semibold text-red-300 mb-1.5">● Low Match ({lowJobs.length})</p>
              {lowJobs.map(j => <JobRow key={j.jobId + j.companyId} job={j} />)}
            </div>
          )}

          {lowJobs.length > 0 && focusTier !== 'low' && (
            <div>
              <button
                className="text-xs text-[#8b949e] hover:text-[#e6edf3] transition-colors mb-1.5 flex items-center gap-1"
                onClick={() => setShowLow(v => !v)}
              >
                {showLow ? '▼' : '▶'} Low Match ({lowJobs.length})
              </button>
              {showLow && lowJobs.map(j => <JobRow key={j.jobId + j.companyId} job={j} />)}
            </div>
          )}

          <LinkedInPanel targets={linkedInTargets} people={linkedInPeople} />
        </div>
      )}
    </div>
  );
}
