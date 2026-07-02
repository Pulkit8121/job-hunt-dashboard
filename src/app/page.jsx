'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import { RefreshCw, Plus, Search, Zap, Briefcase, X, Terminal, ChevronDown, ChevronUp, Bot, Send, Users, CheckCircle2, MapPin, ExternalLink } from 'lucide-react';
import CompanyCard from '@/components/CompanyCard';
import AddCompanyModal from '@/components/AddCompanyModal';
import { getLinkedInPeopleTargets } from '@/lib/linkedin';
import { getProfileHeaderLine } from '@/lib/profile';

const WORK_TABS    = [{ id:'all',label:'All'},{ id:'remote',label:'🌐 Remote'},{ id:'hybrid',label:'🏢 Hybrid'},{ id:'onsite',label:'🏭 Onsite'},{ id:'unknown',label:'❓ Unknown'}];
const TYPE_FILTERS = [{ id:'all',label:'All'},{ id:'easy-mnc',label:'Easy MNC'},{ id:'remote-mnc',label:'Remote MNC'},{ id:'hard',label:'Hard'},{ id:'startup',label:'Startup'}];
const SCAN_FILTERS = [{ id:'all',label:'All'},{ id:'scanned',label:'Scanned'},{ id:'unscanned',label:'Unscanned'}];
const JOB_VIEW_TABS= [{ id:'recommended',label:'Profile Fit'},{ id:'low-match',label:'Low Match'}];
const MAIN_TABS    = [{ id:'dashboard',label:'Dashboard'},{ id:'applied',label:'Applied Jobs'}];

export default function Dashboard() {
  const [companies, setCompanies]     = useState([]);
  const [jobs, setJobs]               = useState([]);
  const [applied, setApplied]         = useState([]);
  const [people, setPeople]           = useState([]);
  const [mainTab, setMainTab]         = useState('dashboard');
  const [jobView, setJobView]         = useState('recommended');
  const [workTab, setWorkTab]         = useState('all');
  const [typeFilter, setTypeFilter]   = useState('all');
  const [scanFilter, setScanFilter]   = useState('all');
  const [search, setSearch]           = useState('');
  const [showModal, setShowModal]     = useState(false);
  const [logs, setLogs]               = useState([]);
  const [scanning, setScanning]       = useState(false);
  const [agentScanning, setAgentScanning] = useState(false);
  const [showLogs, setShowLogs]       = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [logsMinimized, setLogsMinimized] = useState(false);
  const [easyApplying, setEasyApplying]   = useState(false);
  const [wfApplying, setWfApplying]       = useState(false);
  const [wfPhase, setWfPhase]             = useState('all');
  const [liScraping, setLiScraping]   = useState(false);
  const [liConnecting, setLiConnecting]   = useState(false);
  const logsEndRef = useRef(null);

  const addLog = useCallback((msg) => {
    setLogs(prev => [...prev.slice(-299), { msg, t: Date.now() }]);
  }, []);

  useEffect(() => {
    if (showLogs && !logsMinimized) logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs, showLogs, logsMinimized]);

  async function load() {
    const [c, j, a, p] = await Promise.all([
      fetch('/api/companies').then(r => r.json()),
      fetch('/api/jobs').then(r => r.json()),
      fetch('/api/applied').then(r => r.json()).catch(() => []),
      fetch('/api/linkedin-people').then(r => r.json()).catch(() => []),
    ]);
    setCompanies(Array.isArray(c) ? c : []);
    setJobs(Array.isArray(j) ? j : []);
    setApplied(Array.isArray(a) ? a : []);
    setPeople(Array.isArray(p) ? p : []);
  }

  useEffect(() => { load(); }, []);

  async function streamScrape(url, body, label) {
    setShowLogs(true);
    setLogsMinimized(false);
    addLog(`▶ ${label}`);
    const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const { message } = JSON.parse(line.slice(5).trim());
        addLog(message);
        if (message.startsWith('DONE:') || message.startsWith('FATAL:')) await load();
      }
    }
  }

  async function handleRefreshAll()          { setScanning(true);     try { await streamScrape('/api/scrape',          { companyId:'all' },  'Scanning all companies...'); }          finally { setScanning(false); } }
  async function handleAgentScan()           { setAgentScanning(true); try { await streamScrape('/api/agent',           { companyId:'all' },  'Agent scanning all companies...'); }     finally { setAgentScanning(false); } }
  async function handleAgentCompany(id)      { setAgentScanning(true); try { await streamScrape('/api/agent',           { companyId:id },     `Agent scanning ${id}...`); }            finally { setAgentScanning(false); } }
  async function handleRefreshCompany(id)    { await streamScrape('/api/scrape', { companyId:id, bust:true }, `Scanning ${id}...`); await load(); }
  async function handleDiscover()            { setDiscovering(true);  try { await streamScrape('/api/discover',         {},                   'Auto-adding companies from Naukri...'); } finally { setDiscovering(false); } }
  async function handleEasyApplyAll()        { setEasyApplying(true); try { await streamScrape('/api/naukri-apply',    {},                   'Naukri Easy Apply — opening browser...'); } finally { setEasyApplying(false); await load(); } }
  async function handleLiScrape()            { setLiScraping(true);   try { await streamScrape('/api/linkedin-scrape', { companyId:'all' },  'Scraping LinkedIn people...'); }          finally { setLiScraping(false); await load(); } }
  async function handleLiConnect()           { setLiConnecting(true); try { await streamScrape('/api/linkedin-connect',{ limit:20 },         'Sending LinkedIn connection requests...'); } finally { setLiConnecting(false); await load(); } }
  async function handleWellfoundApply(phase) { setWfApplying(true);   try { await streamScrape('/api/wellfound-apply', phase === 'all' ? {} : { phase }, `Wellfound Apply — ${phase === 'all' ? 'all phases' : phase}...`); } finally { setWfApplying(false); await load(); } }
  async function handleApplyBoth() {
    await Promise.all([
      handleEasyApplyAll(),
      handleWellfoundApply(wfPhase),
    ]);
  }

  const jobsByCompany     = {};
  for (const job of jobs) { if (!jobsByCompany[job.companyId]) jobsByCompany[job.companyId] = []; jobsByCompany[job.companyId].push(job); }

  const peopleByCompany   = {};
  for (const p of people) { if (!peopleByCompany[p.companyId]) peopleByCompany[p.companyId] = []; peopleByCompany[p.companyId].push(p); }

  const visibleJobsByCompany = {};
  for (const company of companies) {
    const cj = jobsByCompany[company.id] || [];
    visibleJobsByCompany[company.id] = jobView === 'low-match'
      ? cj.filter(j => j.matchTier === 'low')
      : cj.filter(j => j.matchTier !== 'low');
  }

  const filtered = companies.filter(c => {
    if (workTab !== 'all'    && c.workMode !== workTab)  return false;
    if (typeFilter !== 'all' && c.type !== typeFilter)   return false;
    if (scanFilter === 'scanned'   && !c.lastScraped)    return false;
    if (scanFilter === 'unscanned' && c.lastScraped)     return false;
    if (search && !c.name.toLowerCase().includes(search.toLowerCase())) return false;
    const vj = visibleJobsByCompany[c.id] || [];
    if (jobView === 'low-match'   && vj.length === 0)               return false;
    if (jobView === 'recommended' && c.lastScraped && vj.length === 0) return false;
    return true;
  }).sort((a, b) => {
    const sd = Number(Boolean(b.lastScraped)) - Number(Boolean(a.lastScraped));
    if (sd !== 0) return sd;
    const jd = (visibleJobsByCompany[b.id]?.length || 0) - (visibleJobsByCompany[a.id]?.length || 0);
    if (jd !== 0) return jd;
    return a.name.localeCompare(b.name);
  });

  const totalJobs    = jobs.length;
  const highMatch    = jobs.filter(j => j.matchTier === 'high').length;
  const mediumMatch  = jobs.filter(j => j.matchTier === 'medium').length;
  const lowMatch     = jobs.filter(j => j.matchTier === 'low').length;
  const scannedCount = companies.filter(c => c.lastScraped).length;
  const unscannedCount = companies.length - scannedCount;
  const visibleJobCount = jobView === 'low-match' ? lowMatch : highMatch + mediumMatch;
  const easyApplyCount  = jobs.filter(j => j.source === 'naukri' && j.isEasyApply).length;
  const peopleCount     = people.length;
  const connectedCount  = people.filter(p => p.connected).length;
  const tabCounts       = {};
  for (const t of WORK_TABS) tabCounts[t.id] = t.id === 'all' ? companies.length : companies.filter(c => c.workMode === t.id).length;

  function logColor(msg) {
    if (msg.startsWith('✓') || msg.startsWith('DONE'))  return 'text-emerald-400';
    if (msg.startsWith('✗') || msg.startsWith('FATAL')) return 'text-red-400';
    if (msg.startsWith('⚠'))                             return 'text-yellow-400';
    if (msg.startsWith('🤖') || msg.startsWith('📤'))   return 'text-fuchsia-300';
    if (msg.startsWith('▶') || msg.startsWith('⚡') || msg.startsWith('↗')) return 'text-blue-400';
    if (msg.startsWith('🔍'))                            return 'text-sky-300';
    if (msg.startsWith('○'))                             return 'text-[#484f58]';
    return 'text-[#8b949e]';
  }

  const scanBusy = scanning || discovering || agentScanning || liScraping || liConnecting;
  const busy = scanBusy || easyApplying || wfApplying;

  // ── Applied jobs grouped by company ──────────────────────────────────────────
  const appliedByCompany = {};
  for (const a of applied) {
    if (!appliedByCompany[a.companyId]) appliedByCompany[a.companyId] = { name: a.companyName, jobs: [] };
    appliedByCompany[a.companyId].jobs.push(a);
  }

  return (
    <div className="min-h-screen">
      {/* ── Header ── */}
      <header className="sticky top-0 z-40 bg-[#0d1117]/90 backdrop-blur-md border-b border-[#30363d]">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Briefcase size={20} className="text-emerald-400" />
            <div>
              <h1 className="text-sm font-bold text-[#e6edf3] leading-tight">Job Hunt Dashboard</h1>
              <p className="text-xs text-[#8b949e]">{getProfileHeaderLine()}</p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap justify-end">
            {/* Status chips */}
            <div className="hidden sm:flex items-center gap-2 text-xs">
              <span className="px-2 py-1 rounded-full bg-[#21262d] text-[#8b949e]">{companies.length} companies</span>
              <span className="px-2 py-1 rounded-full bg-blue-900/40 text-blue-300">{scannedCount} scanned</span>
              {totalJobs > 0 && <span className="px-2 py-1 rounded-full bg-emerald-900/40 text-emerald-300">{highMatch} high match</span>}
              {peopleCount > 0 && <span className="px-2 py-1 rounded-full bg-sky-900/40 text-sky-300">{peopleCount} contacts</span>}
              {applied.length > 0 && <span className="px-2 py-1 rounded-full bg-fuchsia-900/40 text-fuchsia-300">{applied.length} applied</span>}
              {scanning    && <span className="px-2 py-1 rounded-full bg-yellow-900/40 text-yellow-300 flex items-center gap-1"><RefreshCw size={10} className="animate-spin" /> scanning...</span>}
              {agentScanning && <span className="px-2 py-1 rounded-full bg-fuchsia-900/40 text-fuchsia-300 flex items-center gap-1"><Bot size={10} className="animate-pulse" /> agent scanning...</span>}
              {discovering && <span className="px-2 py-1 rounded-full bg-yellow-900/40 text-yellow-300 flex items-center gap-1"><Zap size={10} className="animate-pulse" /> auto adding...</span>}
              {easyApplying && <span className="px-2 py-1 rounded-full bg-yellow-900/40 text-yellow-200 flex items-center gap-1"><Send size={10} className="animate-pulse" /> naukri applying...</span>}
              {wfApplying  && <span className="px-2 py-1 rounded-full bg-emerald-900/40 text-emerald-200 flex items-center gap-1"><Bot size={10} className="animate-pulse" /> wellfound applying...</span>}
              {liScraping  && <span className="px-2 py-1 rounded-full bg-sky-900/40 text-sky-200 flex items-center gap-1"><Users size={10} className="animate-pulse" /> scraping LinkedIn...</span>}
              {liConnecting && <span className="px-2 py-1 rounded-full bg-sky-900/40 text-sky-200 flex items-center gap-1"><Send size={10} className="animate-pulse" /> connecting...</span>}
            </div>

            {/* Action buttons */}
            <button onClick={handleLiScrape} disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-900/40 hover:bg-sky-800/50
                text-xs text-sky-100 border border-sky-700/50 transition-colors disabled:opacity-40"
              title="Login to LinkedIn and scrape real names + profile URLs for recruiter/manager/engineer contacts">
              <Users size={12} className={liScraping ? 'animate-pulse' : ''} />
              {liScraping ? 'Scraping...' : `Scrape People${peopleCount > 0 ? ` (${peopleCount})` : ''}`}
            </button>

            {peopleCount > 0 && (
              <button onClick={handleLiConnect} disabled={busy}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-800/50 hover:bg-sky-700/60
                  text-xs text-sky-50 border border-sky-600/50 transition-colors disabled:opacity-40"
                title={`Send LinkedIn connection requests to ${peopleCount - connectedCount} pending contacts (20 per run)`}>
                <Send size={12} className={liConnecting ? 'animate-pulse' : ''} />
                {liConnecting ? 'Connecting...' : `Connect All (${peopleCount - connectedCount} pending)`}
              </button>
            )}

            <button onClick={handleEasyApplyAll} disabled={scanBusy || easyApplying}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-yellow-900/50 hover:bg-yellow-800/60
                text-xs text-yellow-100 border border-yellow-700/50 transition-colors disabled:opacity-40"
              title={easyApplyCount > 0 ? `Easy Apply to ${easyApplyCount} Naukri jobs` : 'Run a scan first to detect Easy Apply jobs'}>
              <Send size={12} className={easyApplying ? 'animate-pulse' : ''} />
              {easyApplying ? 'Applying...' : `Easy Apply${easyApplyCount > 0 ? ` (${easyApplyCount})` : ''}`}
            </button>

            <button onClick={handleApplyBoth} disabled={scanBusy || easyApplying || wfApplying}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-fuchsia-900/50 hover:bg-fuchsia-800/60
                text-xs text-fuchsia-100 border border-fuchsia-700/50 transition-colors disabled:opacity-40"
              title="Run Naukri and Wellfound apply together">
              <Zap size={12} className={easyApplying && wfApplying ? 'animate-pulse' : ''} />
              {easyApplying && wfApplying ? 'Applying Both...' : 'Apply Both'}
            </button>

            <button onClick={handleDiscover} disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#21262d] hover:bg-[#30363d]
                text-xs text-[#8b949e] hover:text-[#e6edf3] border border-[#30363d] transition-colors disabled:opacity-40"
              title="Auto-add new companies from Naukri">
              <Zap size={12} className={discovering ? 'animate-pulse text-yellow-400' : ''} />
              {discovering ? 'Auto Adding...' : 'Auto Add'}
            </button>

            <button onClick={handleAgentScan} disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-fuchsia-900/50 hover:bg-fuchsia-800/60
                text-xs text-fuchsia-100 border border-fuchsia-700/50 transition-colors disabled:opacity-40"
              title="Agent scan career sites more aggressively">
              <Bot size={12} className={agentScanning ? 'animate-pulse' : ''} />
              {agentScanning ? 'Agent Scanning...' : 'Agent Scan'}
            </button>

            <button onClick={() => setShowModal(true)} disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#21262d] hover:bg-[#30363d]
                text-xs text-[#8b949e] hover:text-[#e6edf3] border border-[#30363d] transition-colors disabled:opacity-40">
              <Plus size={12} /> Add
            </button>

            <button onClick={handleRefreshAll} disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-800 hover:bg-emerald-700
                text-xs text-emerald-100 font-medium transition-colors disabled:opacity-40">
              <RefreshCw size={12} className={scanning ? 'animate-spin' : ''} />
              {scanning ? 'Scanning...' : 'Refresh All'}
            </button>
          </div>
        </div>

        {/* Main tabs */}
        <div className="max-w-7xl mx-auto px-4 flex items-center gap-1 pb-1">
          {MAIN_TABS.map(tab => (
            <button key={tab.id} onClick={() => setMainTab(tab.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-t-lg transition-colors ${
                mainTab === tab.id
                  ? 'bg-[#161b22] text-[#e6edf3] border-t border-x border-[#30363d]'
                  : 'text-[#8b949e] hover:text-[#e6edf3]'
              }`}>
              {tab.label}
              {tab.id === 'applied' && applied.length > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] bg-fuchsia-900/50 text-fuchsia-200">{applied.length}</span>
              )}
            </button>
          ))}
        </div>
      </header>

      {/* ── Applied Jobs Tab ── */}
      {mainTab === 'applied' && (
        <main className="max-w-7xl mx-auto px-4 py-6 pb-24">

          {/* Page refresh button */}
          <div className="flex justify-end mb-4">
            <button onClick={load} disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#21262d] hover:bg-[#30363d]
                text-xs text-[#8b949e] hover:text-[#e6edf3] border border-[#30363d] transition-colors disabled:opacity-40">
              <RefreshCw size={12} /> Refresh Status
            </button>
          </div>

          {/* Big Easy Apply CTA */}
          <div className="mb-4 rounded-xl border border-yellow-700/40 bg-yellow-900/10 p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-bold text-yellow-200 flex items-center gap-2">
                <Send size={14} /> Naukri Easy Apply — One Shot
              </h2>
              <p className="text-xs text-yellow-100/60 mt-1">
                Applies to every Naukri job in your dashboard. Answers chatbot questions automatically. Skips company-website jobs and saves their real URLs. Already-skipped jobs are excluded — only fresh jobs are attempted each run.
              </p>
            </div>
            <button onClick={handleEasyApplyAll} disabled={busy}
              className="shrink-0 flex items-center gap-2 px-5 py-2.5 rounded-xl
                bg-yellow-500 hover:bg-yellow-400 active:bg-yellow-600
                text-black font-bold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-lg">
              <Send size={14} className={easyApplying ? 'animate-pulse' : ''} />
              {easyApplying ? 'Applying to all Naukri jobs...' : 'Apply All Naukri Jobs'}
            </button>
          </div>

          {/* Wellfound Apply CTA */}
          <div className="mb-6 rounded-xl border border-emerald-700/40 bg-emerald-900/10 p-5">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-bold text-emerald-200 flex items-center gap-2">
                  <Bot size={14} /> Wellfound Auto-Apply — AI Cover Letters
                </h2>
                <p className="text-xs text-emerald-100/60 mt-1">
                  Phase 1: Indian companies (any work mode) · Phase 2: Remote outside India · Phase 3: Onsite outside India (sponsorship). Generates a unique AI cover letter for each job. Answers all form questions automatically.
                </p>
              </div>
              <div className="flex flex-col gap-2 shrink-0">
                {/* Phase selector */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  {[
                    { id:'all',          label:'All 3 Phases' },
                    { id:'india',        label:'India Only' },
                    { id:'remote-global',label:'Remote Global' },
                    { id:'onsite-global',label:'Onsite + Visa' },
                  ].map(p => (
                    <button key={p.id} onClick={() => setWfPhase(p.id)} disabled={busy}
                      className={`px-2.5 py-1 rounded-full text-xs transition-colors border ${
                        wfPhase === p.id
                          ? 'bg-emerald-800/60 text-emerald-200 border-emerald-600/60'
                          : 'bg-[#21262d] text-[#8b949e] border-[#30363d] hover:text-[#e6edf3]'
                      }`}>
                      {p.label}
                    </button>
                  ))}
                </div>
                <button onClick={() => handleWellfoundApply(wfPhase)} disabled={scanBusy || wfApplying}
                  className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl
                    bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700
                    text-white font-bold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-lg">
                  <Bot size={14} className={wfApplying ? 'animate-pulse' : ''} />
                  {wfApplying ? 'Applying on Wellfound...' : 'Apply All Wellfound Jobs'}
                </button>
                <button onClick={handleApplyBoth} disabled={scanBusy || easyApplying || wfApplying}
                  className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl
                    bg-fuchsia-600 hover:bg-fuchsia-500 active:bg-fuchsia-700
                    text-white font-bold text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-lg">
                  <Zap size={14} className={easyApplying && wfApplying ? 'animate-pulse' : ''} />
                  {easyApplying && wfApplying ? 'Applying on Both...' : 'Apply Naukri + Wellfound'}
                </button>
              </div>
            </div>
          </div>

          {applied.length === 0 ? (
            <div className="text-center py-16 text-[#8b949e]">
              <CheckCircle2 size={40} className="mx-auto mb-4 opacity-20" />
              <p className="text-sm">No applications recorded yet.</p>
              <p className="text-xs mt-2 opacity-60">Click "Apply All Naukri Jobs" above to start — every application is tracked here.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-4 mb-4">
                <Stat label="Total Applied"  value={applied.length} color="text-fuchsia-300" />
                <Stat label="Companies"      value={Object.keys(appliedByCompany).length} color="text-blue-300" />
              </div>
              {Object.entries(appliedByCompany).map(([cid, { name, jobs: cjobs }]) => (
                <div key={cid} className="rounded-xl border border-[#30363d] bg-[#161b22] overflow-hidden">
                  <div className="px-4 py-3 flex items-center justify-between border-b border-[#30363d]">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 size={14} className="text-fuchsia-400" />
                      <span className="text-sm font-semibold text-[#e6edf3]">{name || cid}</span>
                    </div>
                    <span className="text-xs text-fuchsia-300 bg-fuchsia-900/30 px-2 py-0.5 rounded-full border border-fuchsia-700/40">
                      {cjobs.length} applied
                    </span>
                  </div>
                  <div className="divide-y divide-[#21262d]">
                    {cjobs.map((a, i) => (
                      <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-[#e6edf3] truncate">{a.jobTitle}</p>
                          <p className="text-xs text-[#484f58] mt-0.5">
                            {a.appliedAt ? new Date(a.appliedAt).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : ''}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-xs px-2 py-0.5 rounded border bg-amber-900/40 text-amber-300 border-amber-700/40">{a.source}</span>
                          {a.jobLink && (
                            <a href={a.jobLink} target="_blank" rel="noopener noreferrer"
                              className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-[#21262d] hover:bg-[#30363d] text-[#8b949e] hover:text-[#e6edf3] border border-[#30363d] transition-colors">
                              <ExternalLink size={10} /> View
                            </a>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </main>
      )}

      {/* ── Dashboard Tab ── */}
      {mainTab === 'dashboard' && (
        <>
          {/* Filters */}
          <div className="max-w-7xl mx-auto px-4 py-4 space-y-3">
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
              {JOB_VIEW_TABS.map(tab => (
                <button key={tab.id} onClick={() => setJobView(tab.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                    jobView === tab.id ? 'bg-fuchsia-900/40 text-fuchsia-200 border border-fuchsia-700/60' : 'text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]'
                  }`}>
                  {tab.label}
                  {tab.id === 'recommended' && <span className="ml-1 opacity-70">({highMatch + mediumMatch})</span>}
                  {tab.id === 'low-match'   && <span className="ml-1 opacity-70">({lowMatch})</span>}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
              {WORK_TABS.map(tab => (
                <button key={tab.id} onClick={() => setWorkTab(tab.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                    workTab === tab.id ? 'bg-[#21262d] text-[#e6edf3] border border-[#58a6ff]' : 'text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]'
                  }`}>
                  {tab.label} <span className="ml-1 opacity-60">({tabCounts[tab.id]})</span>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1 flex-wrap">
                {TYPE_FILTERS.map(f => (
                  <button key={f.id} onClick={() => setTypeFilter(f.id)}
                    className={`px-2.5 py-1 rounded-full text-xs transition-colors ${
                      typeFilter === f.id ? 'bg-emerald-900/60 text-emerald-300 border border-emerald-700/60' : 'text-[#8b949e] hover:text-[#e6edf3] bg-[#21262d] border border-transparent hover:border-[#30363d]'
                    }`}>{f.label}</button>
                ))}
              </div>
              <div className="flex items-center gap-1 flex-wrap">
                {SCAN_FILTERS.map(f => (
                  <button key={f.id} onClick={() => setScanFilter(f.id)}
                    className={`px-2.5 py-1 rounded-full text-xs transition-colors ${
                      scanFilter === f.id ? 'bg-blue-900/50 text-blue-300 border border-blue-700/60' : 'text-[#8b949e] hover:text-[#e6edf3] bg-[#21262d] border border-transparent hover:border-[#30363d]'
                    }`}>
                    {f.label}
                    {f.id === 'scanned'   && <span className="ml-1 opacity-70">({scannedCount})</span>}
                    {f.id === 'unscanned' && <span className="ml-1 opacity-70">({unscannedCount})</span>}
                  </button>
                ))}
              </div>
              <div className="relative ml-auto">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8b949e]" />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search companies..."
                  className="pl-8 pr-3 py-1.5 rounded-lg bg-[#21262d] border border-[#30363d] text-xs text-[#e6edf3]
                    placeholder:text-[#484f58] focus:outline-none focus:border-[#58a6ff] w-44" />
              </div>
            </div>
          </div>

          {/* Company grid */}
          <main className="max-w-7xl mx-auto px-4 pb-24">
            {filtered.length === 0 ? (
              <div className="text-center py-20 text-[#8b949e]">
                <Briefcase size={40} className="mx-auto mb-4 opacity-30" />
                <p className="text-sm">No companies match your filters.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {filtered.map(company => (
                  <CompanyCard
                    key={company.id}
                    company={company}
                    jobs={visibleJobsByCompany[company.id] || []}
                    linkedInTargets={getLinkedInPeopleTargets(company)}
                    linkedInPeople={peopleByCompany[company.id] || []}
                    onRefresh={handleRefreshCompany}
                    onAgentRefresh={handleAgentCompany}
                    refreshDisabled={busy}
                    focusTier={jobView === 'low-match' ? 'low' : 'all'}
                  />
                ))}
              </div>
            )}

            {companies.length > 0 && (
              <div className="mt-8 p-4 rounded-xl border border-[#30363d] bg-[#161b22] flex items-center justify-between flex-wrap gap-4">
                <div className="flex items-center gap-6">
                  <Stat label="Companies"   value={companies.length} />
                  <Stat label="Scanned"     value={scannedCount}     color="text-blue-400" />
                  <Stat label="Profile Fit" value={visibleJobCount}  color="text-emerald-300" />
                  <Stat label="Jobs Found"  value={totalJobs}        color="text-emerald-400" />
                  <Stat label="LI Contacts" value={peopleCount}      color="text-sky-300" />
                  <Stat label="Applied"     value={applied.length}   color="text-fuchsia-300" />
                </div>
                <p className="text-xs text-[#8b949e]">
                  <strong className="text-emerald-400">Refresh All</strong> → scan ·{' '}
                  <strong className="text-fuchsia-300">Agent Scan</strong> → deep crawl ·{' '}
                  <strong className="text-sky-300">Scrape People</strong> → LinkedIn names ·{' '}
                  <strong className="text-yellow-300">Easy Apply</strong> → auto-apply Naukri
                </p>
              </div>
            )}
          </main>
        </>
      )}

      {/* ── Floating logs terminal (bottom-right) ── */}
      {showLogs && (
        <div className="fixed bottom-4 right-4 z-50 w-96 rounded-xl border border-[#30363d] bg-[#0d1117] shadow-2xl overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 bg-[#161b22] border-b border-[#30363d]">
            <div className="flex items-center gap-2">
              <Terminal size={12} className="text-emerald-400" />
              <span className="text-xs font-medium text-[#8b949e]">Scan Log</span>
              {busy && <RefreshCw size={10} className="animate-spin text-yellow-400" />}
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => setLogsMinimized(v => !v)} className="p-1 text-[#8b949e] hover:text-[#e6edf3]">
                {logsMinimized ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              </button>
              <button onClick={() => setShowLogs(false)} className="p-1 text-[#8b949e] hover:text-[#e6edf3]">
                <X size={13} />
              </button>
            </div>
          </div>
          {!logsMinimized && (
            <div className="h-56 overflow-y-auto px-3 py-2 font-mono space-y-0.5">
              {logs.length === 0
                ? <p className="text-xs text-[#484f58]">No activity yet.</p>
                : logs.map((l, i) => <p key={i} className={`text-xs leading-5 ${logColor(l.msg)}`}>{l.msg}</p>)
              }
              <div ref={logsEndRef} />
            </div>
          )}
        </div>
      )}

      {!showLogs && (
        <button onClick={() => setShowLogs(true)}
          className="fixed bottom-4 right-4 z-50 flex items-center gap-2 px-3 py-2 rounded-lg
            bg-[#161b22] border border-[#30363d] text-xs text-[#8b949e] hover:text-[#e6edf3]
            hover:bg-[#21262d] transition-colors shadow-lg">
          <Terminal size={12} /> Logs {logs.length > 0 && <span className="bg-emerald-700 text-emerald-100 rounded-full px-1.5">{logs.length}</span>}
        </button>
      )}

      {showModal && (
        <AddCompanyModal
          onClose={() => setShowModal(false)}
          onAdded={company => { setCompanies(prev => [...prev, company]); setShowModal(false); }}
        />
      )}
    </div>
  );
}

function Stat({ label, value, color = 'text-[#e6edf3]' }) {
  return (
    <div>
      <p className={`text-lg font-bold ${color}`}>{value}</p>
      <p className="text-xs text-[#8b949e]">{label}</p>
    </div>
  );
}
