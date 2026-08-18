'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { Search, Send, Mail, RefreshCw, X, Trash2, Sparkles, Newspaper, Database, Rocket, ShieldCheck, Power } from 'lucide-react';

function isSentToday(date) {
  if (!date) return false;
  const d = new Date(date);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

const STATUS_BADGE = {
  pending: 'bg-gray-700/40 text-gray-300 border-gray-600/40',
  sent:    'bg-blue-900/40 text-blue-300 border-blue-700/40',
  skipped: 'bg-gray-700/40 text-gray-400 border-gray-600/40',
  bounced: 'bg-red-900/40 text-red-300 border-red-700/40',
  invalid: 'bg-orange-900/40 text-orange-300 border-orange-700/40',
};

const REPLY_BADGE = {
  interested: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/40',
  rejected:   'bg-red-900/40 text-red-300 border-red-700/40',
  'auto-reply': 'bg-gray-700/40 text-gray-400 border-gray-600/40',
  other:      'bg-amber-900/40 text-amber-300 border-amber-700/40',
};

const CONFIDENCE_COLOR = {
  high:   'text-emerald-400',
  medium: 'text-amber-400',
  low:    'text-red-400',
};

const TABLE_PAGE_SIZE = 100;

export default function OutreachPanel({ streamScrape, busy }) {
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [discoveringHn, setDiscoveringHn] = useState(false);
  const [discoveringSources, setDiscoveringSources] = useState(false);
  const [discoveringYc, setDiscoveringYc] = useState(false);
  const [sending, setSending] = useState(false);
  const [checkingReplies, setCheckingReplies] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [testSending, setTestSending] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [cap, setCap] = useState(175);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [visibleCount, setVisibleCount] = useState(TABLE_PAGE_SIZE);
  const [identities, setIdentities] = useState([]);
  const [sendingIdentity, setSendingIdentity] = useState(null); // identityId currently mid-send, or null
  const [sendCounts, setSendCounts] = useState({}); // identityId -> the "send N now" box value
  const [savingSettings, setSavingSettings] = useState({}); // identityId -> true while a settings PATCH is in flight
  const [retryingBounced, setRetryingBounced] = useState(false);
  const [manualEmail, setManualEmail] = useState('');
  const [manualCompany, setManualCompany] = useState('');
  const [manualIdentity, setManualIdentity] = useState('primary');
  const [manualSending, setManualSending] = useState(false);
  const [manualResult, setManualResult] = useState(null);

  const loadIdentities = useCallback(async () => {
    try {
      const res = await fetch('/api/outreach/identity-settings').then(r => r.json());
      setIdentities(Array.isArray(res) ? res : []);
    } catch { setIdentities([]); }
  }, []);

  useEffect(() => { loadIdentities(); }, [loadIdentities]);

  async function handleToggleAuto(identityId, next) {
    setIdentities(prev => prev.map(i => i.id === identityId ? { ...i, autoSendEnabled: next } : i));
    setSavingSettings(prev => ({ ...prev, [identityId]: true }));
    try {
      await fetch('/api/outreach/identity-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityId, autoSendEnabled: next }),
      });
    } finally {
      setSavingSettings(prev => ({ ...prev, [identityId]: false }));
    }
  }

  async function handleDailyLimitChange(identityId, value) {
    const n = Number(value);
    setIdentities(prev => prev.map(i => i.id === identityId ? { ...i, dailyLimit: value } : i));
    if (!Number.isFinite(n) || n < 0) return;
    setSavingSettings(prev => ({ ...prev, [identityId]: true }));
    try {
      await fetch('/api/outreach/identity-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identityId, dailyLimit: n }),
      });
    } finally {
      setSavingSettings(prev => ({ ...prev, [identityId]: false }));
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/outreach/contacts');
      const data = await res.json();
      setContacts(Array.isArray(data) ? data : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleDiscover() {
    setDiscovering(true);
    try {
      await streamScrape('/api/outreach/discover', { cap }, `Discovering up to ${cap} HR/careers contacts...`);
    } finally {
      setDiscovering(false);
      await load();
    }
  }

  async function handleDiscoverHn() {
    setDiscoveringHn(true);
    try {
      await streamScrape('/api/outreach/discover-hn', {}, 'Scanning latest HN "Who is hiring?" thread...');
    } finally {
      setDiscoveringHn(false);
      await load();
    }
  }

  async function handleDiscoverSources() {
    setDiscoveringSources(true);
    try {
      await streamScrape('/api/outreach/discover-sources', { sources: ['github','mca','producthunt'] },
        'Mining GitHub commits, MCA India registry and Product Hunt for contacts...');
    } finally {
      setDiscoveringSources(false);
      await load();
    }
  }

  async function handleDiscoverYc() {
    setDiscoveringYc(true);
    try {
      await streamScrape('/api/outreach/discover-yc', { cap: 200, onlyHiring: true },
        'Scanning Y Combinator companies (US/Europe/global startups) for contacts...');
    } finally {
      setDiscoveringYc(false);
      await load();
    }
  }

  async function handleTestSend() {
    setTestSending(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/outreach/test-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyName: contacts[0]?.companyName || 'Example Company' }),
      });
      const data = await res.json();
      setTestResult(res.ok
        ? { ok: true, msg: `Test email sent to ${data.to}. Check your inbox.` }
        : { ok: false, msg: data.error || 'Test send failed' });
    } catch (e) {
      setTestResult({ ok: false, msg: e.message });
    } finally {
      setTestSending(false);
    }
  }

  async function handleSend(identityId, explicitCount) {
    setSendingIdentity(identityId);
    setSending(true);
    try {
      const label = identities.find(i => i.id === identityId)?.label || identityId;
      const body = explicitCount ? { identityId, explicitCount } : { identityId };
      const desc = explicitCount
        ? `Sending ${explicitCount} outreach email(s) via ${label}...`
        : `Sending outreach emails via ${label}...`;
      await streamScrape('/api/outreach/send', body, desc);
    } finally {
      setSendingIdentity(null);
      setSending(false);
      await load();
    }
  }

  async function handleRetryBounced(identityId) {
    setRetryingBounced(true);
    try {
      await streamScrape('/api/outreach/send', { identityId, retryBounced: true }, `Retrying bounced contacts via ${identities.find(i => i.id === identityId)?.label || identityId}...`);
    } finally {
      setRetryingBounced(false);
      await load();
    }
  }

  async function handleManualSend() {
    if (!manualEmail.trim()) return;
    setManualSending(true);
    setManualResult(null);
    try {
      const res = await fetch('/api/outreach/send-manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: manualEmail.trim(), companyName: manualCompany.trim(), identityId: manualIdentity }),
      });
      const data = await res.json();
      setManualResult(res.ok
        ? { ok: true, msg: `Sent to ${data.email} via ${data.sentVia}.` }
        : { ok: false, msg: data.error || 'Send failed' });
      if (res.ok) { setManualEmail(''); setManualCompany(''); await load(); }
    } catch (e) {
      setManualResult({ ok: false, msg: e.message });
    } finally {
      setManualSending(false);
    }
  }

  async function handleStopSend() {
    try { await fetch('/api/outreach/send/stop', { method: 'POST' }); } catch {}
  }

  async function handleVerifyEmails() {
    setVerifying(true);
    try {
      await streamScrape('/api/outreach/verify-emails', {}, 'Checking pending addresses for a valid mail domain (MX lookup)...');
    } finally {
      setVerifying(false);
      await load();
    }
  }

  async function handleCheckReplies() {
    setCheckingReplies(true);
    try {
      await streamScrape('/api/outreach/check-replies', {}, 'Checking inbox for replies...');
    } finally {
      setCheckingReplies(false);
      await load();
    }
  }

  async function handleDelete(email) {
    await fetch('/api/outreach/contacts', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    setContacts(prev => prev.filter(c => c.email !== email));
  }

  const stats = useMemo(() => ({
    total: contacts.length,
    pending: contacts.filter(c => c.status === 'pending').length,
    sent: contacts.filter(c => c.status === 'sent').length,
    bounced: contacts.filter(c => c.status === 'bounced').length,
    invalid: contacts.filter(c => c.status === 'invalid').length,
    replied: contacts.filter(c => !!c.replyStatus).length,
    awaitingReply: contacts.filter(c => c.status === 'sent' && !c.replyStatus).length,
    interested: contacts.filter(c => c.replyStatus === 'interested').length,
    rejected: contacts.filter(c => c.replyStatus === 'rejected').length,
  }), [contacts]);

  // With thousands of contacts, rendering the full list unconditionally
  // crashes the tab — filter by status + search text, then paginate what's
  // actually shown so the DOM never holds more than a page at a time.
  const filteredContacts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return contacts.filter(c => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false;
      if (!q) return true;
      return c.companyName?.toLowerCase().includes(q) || c.email?.toLowerCase().includes(q);
    });
  }, [contacts, search, statusFilter]);

  const visibleContacts = filteredContacts.slice(0, visibleCount);

  useEffect(() => { setVisibleCount(TABLE_PAGE_SIZE); }, [search, statusFilter]);

  return (
    <div className="space-y-6">
      {/* Discovery + test-send CTA */}
      <div className="rounded-xl border border-sky-700/40 bg-sky-900/10 p-5 space-y-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-bold text-sky-200 flex items-center gap-2">
              <Search size={14} /> Discover HR/Careers Contacts
            </h2>
            <p className="text-xs text-sky-100/60 mt-1">
              Checks each tracked company's careers page (or looks up their site) for a public HR/careers email — one contact per company, not a scrape of everyone.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <input
              type="number"
              value={cap}
              onChange={(e) => setCap(Number(e.target.value) || 0)}
              className="w-20 rounded-md bg-[#0d1117] border border-[#30363d] px-2 py-2 text-sm text-[#e6edf3] focus:outline-none focus:border-sky-600"
              min={1}
              max={500}
            />
            <button onClick={handleDiscover} disabled={busy || discovering}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500
                text-white font-bold text-sm transition-colors disabled:opacity-40 shadow-lg">
              <Search size={14} className={discovering ? 'animate-pulse' : ''} />
              {discovering ? 'Discovering...' : 'Discover Contacts'}
            </button>
          </div>
        </div>
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pt-3 border-t border-sky-700/20">
          <div>
            <h2 className="text-sm font-bold text-sky-200 flex items-center gap-2">
              <Newspaper size={14} /> Scan HN &quot;Who is Hiring?&quot;
            </h2>
            <p className="text-xs text-sky-100/60 mt-1">
              Pulls the latest monthly Hacker News hiring thread and saves any contact email each company posted directly in their listing.
            </p>
          </div>
          <button onClick={handleDiscoverHn} disabled={busy || discoveringHn}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-sky-700 hover:bg-sky-600
              text-white font-bold text-sm transition-colors disabled:opacity-40 shadow-lg shrink-0">
            <Newspaper size={14} className={discoveringHn ? 'animate-pulse' : ''} />
            {discoveringHn ? 'Scanning thread...' : 'Scan HN Thread'}
          </button>
        </div>
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pt-3 border-t border-sky-700/20">
          <div>
            <h2 className="text-sm font-bold text-sky-200 flex items-center gap-2">
              <Database size={14} /> Mine All Free Sources
            </h2>
            <p className="text-xs text-sky-100/60 mt-1">
              Public GitHub commits (real engineer/founder addresses, and learns each company&apos;s email format), the MCA India company registry (Karnataka IT firms), and Product Hunt founders. No paid API needed &mdash; set GITHUB_TOKEN and DATA_GOV_IN_API_KEY for full rate limits.
            </p>
          </div>
          <button onClick={handleDiscoverSources} disabled={busy || discoveringSources}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-violet-700 hover:bg-violet-600
              text-white font-bold text-sm transition-colors disabled:opacity-40 shadow-lg shrink-0">
            <Database size={14} className={discoveringSources ? 'animate-pulse' : ''} />
            {discoveringSources ? 'Mining sources...' : 'Mine All Sources'}
          </button>
        </div>
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pt-3 border-t border-sky-700/20">
          <div>
            <h2 className="text-sm font-bold text-sky-200 flex items-center gap-2">
              <Rocket size={14} /> Y Combinator Companies (US / Europe / Global)
            </h2>
            <p className="text-xs text-sky-100/60 mt-1">
              YC&apos;s own public company directory (4,200+ active, 1,480+ currently hiring) &mdash; their real website is already known, so this skips search entirely and crawls directly for a contact.
            </p>
          </div>
          <button onClick={handleDiscoverYc} disabled={busy || discoveringYc}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-orange-700 hover:bg-orange-600
              text-white font-bold text-sm transition-colors disabled:opacity-40 shadow-lg shrink-0">
            <Rocket size={14} className={discoveringYc ? 'animate-pulse' : ''} />
            {discoveringYc ? 'Scanning YC...' : 'Scan YC Companies'}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-emerald-700/40 bg-emerald-900/10 p-5 space-y-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-bold text-emerald-200 flex items-center gap-2">
              <Sparkles size={14} /> Send Test Email First
            </h2>
            <p className="text-xs text-emerald-100/60 mt-1">
              Sends one AI-generated cover letter + resume to your own inbox — nothing is marked as sent to any real contact.
            </p>
          </div>
          <button onClick={handleTestSend} disabled={testSending}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500
              text-white font-bold text-sm transition-colors disabled:opacity-40 shadow-lg shrink-0">
            <Mail size={14} className={testSending ? 'animate-pulse' : ''} />
            {testSending ? 'Sending test...' : 'Send Test to Myself'}
          </button>
        </div>
        {testResult && (
          <p className={`text-xs ${testResult.ok ? 'text-emerald-300' : 'text-red-400'}`}>{testResult.msg}</p>
        )}
      </div>

      {/* Email verification CTA */}
      <div className="rounded-xl border border-sky-700/40 bg-sky-900/10 p-5">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-bold text-sky-200 flex items-center gap-2">
              <ShieldCheck size={14} /> Verify Pending Addresses
            </h2>
            <p className="text-xs text-sky-100/60 mt-1">
              Checks every pending address&apos;s domain has a real mail server (MX record lookup) before sending — catches typos and dead domains. Bad ones are marked &quot;invalid&quot; and excluded from sends; doesn&apos;t affect Gmail&apos;s own daily limit.
              {stats.invalid > 0 && <span className="text-red-300"> {stats.invalid} marked invalid so far.</span>}
            </p>
          </div>
          <button onClick={handleVerifyEmails} disabled={busy || verifying || stats.pending === 0}
            className="shrink-0 flex items-center gap-2 px-5 py-2.5 rounded-xl bg-sky-500 hover:bg-sky-400
              text-black font-bold text-sm transition-colors disabled:opacity-40 shadow-lg">
            <ShieldCheck size={14} className={verifying ? 'animate-pulse' : ''} />
            {verifying ? 'Verifying...' : `Verify ${stats.pending} Pending`}
          </button>
        </div>
      </div>

      {/* Per-identity send controls */}
      <div className="rounded-xl border border-yellow-700/40 bg-yellow-900/10 p-5 space-y-4">
        <div>
          <h2 className="text-sm font-bold text-yellow-200 flex items-center gap-2">
            <Send size={14} /> Send to Pending Contacts
          </h2>
          <p className="text-xs text-yellow-100/60 mt-1">
            Rate-limited (20-45s between sends) so neither Gmail account gets flagged. Each identity has its own daily limit, automatic-sending switch, and today's count — automatic + manual sends together can never cross that identity's limit.
          </p>
        </div>

        {identities.map(i => {
          const sentToday = contacts.filter(c => c.status === 'sent' && c.sentFromIdentity === i.id && isSentToday(c.sentAt)).length;
          const remaining = Math.max(0, (Number(i.dailyLimit) || 0) - sentToday);
          const count = sendCounts[i.id] ?? '';
          const isSendingThis = sendingIdentity === i.id;
          return (
            <div key={i.id} className="rounded-lg border border-[#30363d] bg-[#0d1117] p-3 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-[#e6edf3]">{i.label}</span>
                  {!i.configured && <span className="text-[10px] text-red-400">no app password set</span>}
                  {savingSettings[i.id] && <span className="text-[10px] text-[#8b949e]">saving…</span>}
                </div>
                <button
                  onClick={() => handleToggleAuto(i.id, !i.autoSendEnabled)}
                  disabled={!i.configured}
                  title={i.autoSendEnabled ? 'Automatic sending is ON — click to turn off' : 'Automatic sending is OFF — click to turn on'}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border transition-colors disabled:opacity-40 ${
                    i.autoSendEnabled
                      ? 'bg-emerald-900/40 text-emerald-300 border-emerald-700/40'
                      : 'bg-gray-700/40 text-gray-400 border-gray-600/40'
                  }`}>
                  <Power size={12} />
                  Automatic sending: {i.autoSendEnabled ? 'ON' : 'OFF'}
                </button>
              </div>

              <div className="flex flex-wrap items-end gap-4">
                <div>
                  <label className="block text-[10px] text-[#8b949e] mb-1">Daily limit</label>
                  <input
                    type="number" min={0} value={i.dailyLimit}
                    onChange={e => handleDailyLimitChange(i.id, e.target.value)}
                    disabled={!i.configured}
                    className="w-24 px-2 py-1.5 rounded-md bg-[#161b22] border border-[#30363d] text-xs text-[#e6edf3] disabled:opacity-40"
                  />
                </div>
                <div className="text-xs text-[#8b949e]">
                  Sent today: <span className="text-[#e6edf3] font-medium">{sentToday}</span> / {i.dailyLimit} · {remaining} left
                </div>
                <div>
                  <label className="block text-[10px] text-[#8b949e] mb-1">Send this many now</label>
                  <input
                    type="number" min={1} placeholder="e.g. 20" value={count}
                    onChange={e => setSendCounts(prev => ({ ...prev, [i.id]: e.target.value }))}
                    disabled={!i.configured}
                    className="w-24 px-2 py-1.5 rounded-md bg-[#161b22] border border-[#30363d] text-xs text-[#e6edf3] placeholder:text-[#484f58] disabled:opacity-40"
                  />
                </div>
                <button
                  onClick={() => handleSend(i.id, count ? Number(count) : undefined)}
                  disabled={busy || sending || !i.configured || stats.pending === 0 || remaining === 0}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl bg-yellow-500 hover:bg-yellow-400
                    text-black font-bold text-xs transition-colors disabled:opacity-40 shadow-lg">
                  <Send size={13} className={isSendingThis ? 'animate-pulse' : ''} />
                  {isSendingThis
                    ? 'Sending...'
                    : count
                      ? `Send ${count} now`
                      : remaining === 0 ? 'Daily limit reached' : `Send (trickle, up to ${remaining} left today)`}
                </button>
                {isSendingThis && (
                  <button onClick={handleStopSend}
                    className="flex items-center gap-2 px-3 py-2 rounded-xl bg-red-600 hover:bg-red-500
                      text-white font-bold text-xs transition-colors shadow-lg">
                    <X size={13} /> Stop
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Retry bounced with a different identity */}
      {stats.bounced > 0 && (
        <div className="rounded-xl border border-red-700/40 bg-red-900/10 p-5">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-bold text-red-200 flex items-center gap-2">
                <RefreshCw size={14} /> Retry {stats.bounced} Bounced Contact(s)
              </h2>
              <p className="text-xs text-red-100/60 mt-1">
                Re-sends everything currently marked &quot;bounced&quot; using a chosen identity — useful for retrying via a fresh, unblemished account after the primary&apos;s sending reputation took a hit.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {identities.filter(i => i.configured).map(i => (
                <button key={i.id} onClick={() => handleRetryBounced(i.id)} disabled={busy || retryingBounced}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500
                    text-white font-bold text-sm transition-colors disabled:opacity-40 shadow-lg">
                  <RefreshCw size={14} className={retryingBounced ? 'animate-spin' : ''} />
                  Retry via {i.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Manual single send */}
      <div className="rounded-xl border border-teal-700/40 bg-teal-900/10 p-5">
        <h2 className="text-sm font-bold text-teal-200 flex items-center gap-2 mb-3">
          <Mail size={14} /> Send Manually
        </h2>
        <div className="flex flex-col sm:flex-row gap-2">
          <input value={manualEmail} onChange={e => setManualEmail(e.target.value)} placeholder="hr@company.com"
            className="flex-1 px-3 py-2 rounded-lg bg-[#161b22] border border-[#30363d] text-xs text-[#e6edf3] placeholder:text-[#484f58]" />
          <input value={manualCompany} onChange={e => setManualCompany(e.target.value)} placeholder="Company name (optional)"
            className="flex-1 px-3 py-2 rounded-lg bg-[#161b22] border border-[#30363d] text-xs text-[#e6edf3] placeholder:text-[#484f58]" />
          <select value={manualIdentity} onChange={e => setManualIdentity(e.target.value)}
            className="px-2.5 py-2 rounded-lg bg-[#161b22] border border-[#30363d] text-xs text-[#e6edf3]">
            {identities.map(i => (
              <option key={i.id} value={i.id} disabled={!i.configured}>
                {i.label}{!i.configured ? ' (no app password set)' : ''}
              </option>
            ))}
          </select>
          <button onClick={handleManualSend} disabled={manualSending || !manualEmail.trim()}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-teal-500 hover:bg-teal-400
              text-black font-bold text-xs transition-colors disabled:opacity-40 shrink-0">
            <Send size={12} className={manualSending ? 'animate-pulse' : ''} />
            {manualSending ? 'Sending...' : 'Send Now'}
          </button>
        </div>
        {manualResult && (
          <p className={`text-xs mt-2 ${manualResult.ok ? 'text-emerald-300' : 'text-red-300'}`}>{manualResult.msg}</p>
        )}
      </div>

      {/* Stats + reply check */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-6">
          <Stat label="Contacts" value={stats.total} color="text-sky-300" />
          <Stat label="Pending" value={stats.pending} color="text-gray-300" />
          <Stat label="Sent" value={stats.sent} color="text-blue-300" />
          <Stat label="Bounced" value={stats.bounced} color="text-red-400" />
          <Stat label="Invalid" value={stats.invalid} color="text-orange-400" />
          <Stat label="Replied" value={stats.replied} color="text-amber-300" />
          <Stat label="Awaiting" value={stats.awaitingReply} color="text-gray-400" />
          <Stat label="Interested" value={stats.interested} color="text-emerald-300" />
          <Stat label="Rejected" value={stats.rejected} color="text-red-300" />
        </div>
        <button onClick={handleCheckReplies} disabled={checkingReplies || stats.sent === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#21262d] hover:bg-[#30363d]
            text-xs text-[#8b949e] hover:text-[#e6edf3] border border-[#30363d] transition-colors disabled:opacity-40">
          <RefreshCw size={12} className={checkingReplies ? 'animate-spin' : ''} />
          {checkingReplies ? 'Checking inbox...' : 'Check Replies'}
        </button>
      </div>

      {/* Contacts table */}
      {loading ? (
        <p className="text-sm text-[#8b949e]">Loading contacts...</p>
      ) : contacts.length === 0 ? (
        <div className="text-center py-16 text-[#8b949e]">
          <Mail size={40} className="mx-auto mb-4 opacity-20" />
          <p className="text-sm">No contacts discovered yet.</p>
          <p className="text-xs mt-2 opacity-60">Click "Discover Contacts" above to start.</p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 flex-wrap">
              {['all', 'pending', 'sent', 'bounced', 'invalid', 'skipped'].map(s => (
                <button key={s} onClick={() => setStatusFilter(s)}
                  className={`px-2.5 py-1 rounded-full text-xs transition-colors border ${
                    statusFilter === s
                      ? 'bg-sky-800/60 text-sky-200 border-sky-600/60'
                      : 'bg-[#21262d] text-[#8b949e] border-[#30363d] hover:text-[#e6edf3]'
                  }`}>
                  {s === 'all' ? `All (${stats.total})` : `${s} (${stats[s] ?? contacts.filter(c => c.status === s).length})`}
                </button>
              ))}
            </div>
            <div className="relative w-full sm:w-64">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8b949e]" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter by company or email..."
                className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#161b22] border border-[#30363d] text-sm text-[#e6edf3] placeholder-[#484f58] focus:outline-none focus:border-sky-600"
              />
            </div>
          </div>

          {filteredContacts.length === 0 ? (
            <p className="text-sm text-[#8b949e] py-8 text-center">No contacts match this filter.</p>
          ) : (
        <div className="rounded-xl border border-[#30363d] bg-[#161b22] overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#30363d] text-left text-xs text-[#8b949e]">
                <th className="px-4 py-2 font-medium">Company</th>
                <th className="px-4 py-2 font-medium">Email</th>
                <th className="px-4 py-2 font-medium">Source</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Reply</th>
                <th className="px-4 py-2 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#21262d]">
              {visibleContacts.map((c) => (
                <tr key={c.email}>
                  <td className="px-4 py-2 text-[#e6edf3]">{c.companyName}</td>
                  <td className="px-4 py-2 text-[#8b949e]">{c.email}</td>
                  <td className="px-4 py-2">
                    <span className={CONFIDENCE_COLOR[c.confidence] || 'text-gray-400'}>{c.source}</span>
                  </td>
                  <td className="px-4 py-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${STATUS_BADGE[c.status] || STATUS_BADGE.pending}`}
                      title={(c.status === 'bounced' || c.status === 'invalid') ? (c.lastFailReason || '') : ''}>
                      {c.status}
                    </span>
                    {c.sentFromIdentity && (
                      <span className="ml-1.5 text-[10px] text-[#8b949e]" title={`Sent via ${identities.find(i => i.id === c.sentFromIdentity)?.label || c.sentFromIdentity}`}>
                        via {identities.find(i => i.id === c.sentFromIdentity)?.label?.split('@')[0] || c.sentFromIdentity}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {c.replyStatus && (
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${REPLY_BADGE[c.replyStatus] || REPLY_BADGE.other}`}
                        title={c.replySnippet || ''}>
                        {c.replyStatus}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => handleDelete(c.email)}
                      className="text-[#8b949e] hover:text-red-400 transition-colors" title="Remove contact">
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
          )}

          <div className="flex items-center justify-between text-xs text-[#8b949e]">
            <span>Showing {visibleContacts.length} of {filteredContacts.length}{filteredContacts.length !== contacts.length ? ` (filtered from ${contacts.length})` : ''}</span>
            {visibleCount < filteredContacts.length && (
              <button onClick={() => setVisibleCount(v => v + TABLE_PAGE_SIZE)}
                className="px-3 py-1.5 rounded-lg bg-[#21262d] hover:bg-[#30363d] text-[#8b949e] hover:text-[#e6edf3] border border-[#30363d] transition-colors">
                Load {Math.min(TABLE_PAGE_SIZE, filteredContacts.length - visibleCount)} more
              </button>
            )}
          </div>
        </div>
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
