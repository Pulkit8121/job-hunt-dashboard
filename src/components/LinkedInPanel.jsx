'use client';
import { useState } from 'react';
import { Users, Copy, Check, ExternalLink, UserCheck, Search } from 'lucide-react';

function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy(e) {
    e.preventDefault(); e.stopPropagation();
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch {}
  }
  return (
    <button onClick={handleCopy}
      className="flex items-center gap-1 rounded border border-[#30363d] bg-[#0d1117] hover:bg-[#21262d]
        transition-colors text-[#8b949e] hover:text-[#e6edf3] px-1.5 py-0.5 text-[10px] shrink-0"
      title="Copy referral message for this person type">
      {copied ? <Check size={9} className="text-emerald-400" /> : <Copy size={9} />}
      {copied ? 'Copied!' : 'Copy msg'}
    </button>
  );
}

const CARD_STYLE = {
  recruiter: { border: 'border-blue-800/40',    bg: 'bg-[#0d419d]/20 hover:bg-[#1158d4]/20', label: 'text-blue-200',    sub: 'text-blue-100/70',    tag: 'bg-blue-900/40 text-blue-300' },
  manager:   { border: 'border-purple-800/40',  bg: 'bg-purple-900/10 hover:bg-purple-900/20', label: 'text-purple-200', sub: 'text-purple-100/70', tag: 'bg-purple-900/40 text-purple-300' },
  peer:      { border: 'border-emerald-800/40', bg: 'bg-emerald-900/10 hover:bg-emerald-900/20', label: 'text-emerald-200', sub: 'text-emerald-100/70', tag: 'bg-emerald-900/40 text-emerald-300' },
};
const TYPE_LABEL = { recruiter: 'Recruiter', manager: 'Manager', peer: 'Peer' };

const SEARCH_TYPE_TO_MESSAGE_TYPE = {
  'talent-acquisition': 'recruiter',
  'technical-recruiters': 'recruiter',
  'early-careers': 'recruiter',
  'people-partners': 'recruiter',
  'engineering-managers': 'manager',
  'backend-platform': 'manager',
  'senior-engineers': 'peer',
  'tech-leads': 'peer',
};

// ── People card (real scraped person) ────────────────────────────────────────
function PersonCard({ person }) {
  const msgType = SEARCH_TYPE_TO_MESSAGE_TYPE[person.searchType] || 'recruiter';
  const style = CARD_STYLE[msgType] || CARD_STYLE.recruiter;
  return (
    <div className={`rounded-lg border ${style.border} ${style.bg} px-3 py-2 transition-colors`}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <a href={person.profileUrl} target="_blank" rel="noopener noreferrer"
          className={`flex items-center gap-1 text-xs font-medium ${style.label} hover:underline truncate`}
          title="Open LinkedIn profile">
          {person.name} <ExternalLink size={10} className="shrink-0" />
        </a>
        <div className="flex items-center gap-1.5 shrink-0">
          {person.connected && (
            <span className="flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-900/40 text-emerald-300 border border-emerald-700/40">
              <UserCheck size={9} /> Sent
            </span>
          )}
          <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${style.tag}`}>
            {TYPE_LABEL[msgType]}
          </span>
          <CopyBtn text={person.message || ''} />
        </div>
      </div>
      {person.title && (
        <p className={`text-[10px] leading-4 ${style.sub} truncate`}>{person.title}</p>
      )}
    </div>
  );
}

// ── Search URL card (fallback when no people scraped yet) ────────────────────
function SearchCard({ target }) {
  const style = CARD_STYLE[target.messageType] || CARD_STYLE.recruiter;
  return (
    <div className={`rounded-lg border ${style.border} ${style.bg} px-3 py-2 transition-colors`}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <a href={target.url} target="_blank" rel="noopener noreferrer"
          className={`flex items-center gap-1 text-xs font-medium ${style.label} hover:underline`}
          title="Open LinkedIn people search">
          {target.label} <ExternalLink size={10} />
        </a>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${style.tag}`}>
            {TYPE_LABEL[target.messageType]}
          </span>
          <CopyBtn text={target.message} />
        </div>
      </div>
      <p className={`text-[10px] leading-4 ${style.sub}`}>{target.description}</p>
    </div>
  );
}

export default function LinkedInPanel({ targets = [], people = [] }) {
  const hasPeople = people.length > 0;

  return (
    <div className="mt-3 pt-3 border-t border-[#30363d]">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-[#8b949e] flex items-center gap-1">
          <Users size={12} />
          {hasPeople
            ? `${people.length} LinkedIn contact${people.length !== 1 ? 's' : ''} found`
            : 'LinkedIn outreach — open search, find someone, paste copied message'}
        </p>
        {!hasPeople && (
          <span className="text-[10px] text-[#484f58] flex items-center gap-1">
            <Search size={9} /> Use "Scrape People" to auto-fetch names
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {hasPeople
          ? people.map(p => <PersonCard key={p.profileUrl || p.name} person={p} />)
          : targets.map(t => <SearchCard key={t.id} target={t} />)
        }
      </div>

      <p className="mt-2 text-[10px] text-[#484f58] leading-4">
        {hasPeople
          ? 'Click a name to open their LinkedIn profile. Copy their personalized message, then paste it as your connection note (300 char limit). Use "Connect All" in the header to automate.'
          : 'Each "Copy msg" gives a tailored note (recruiter / manager / peer). Paste as your LinkedIn connection note.'}
      </p>
    </div>
  );
}
