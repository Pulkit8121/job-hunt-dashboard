'use client';
import { useState, useEffect, useCallback } from 'react';
import { Search, Send, Mail, RefreshCw, X, Trash2, Sparkles } from 'lucide-react';

const STATUS_BADGE = {
  pending: 'bg-gray-700/40 text-gray-300 border-gray-600/40',
  sent:    'bg-blue-900/40 text-blue-300 border-blue-700/40',
  skipped: 'bg-gray-700/40 text-gray-400 border-gray-600/40',
  bounced: 'bg-red-900/40 text-red-300 border-red-700/40',
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

export default function OutreachPanel({ streamScrape, busy }) {
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [sending, setSending] = useState(false);
  const [checkingReplies, setCheckingReplies] = useState(false);
  const [testSending, setTestSending] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [cap, setCap] = useState(175);

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

  async function handleSend() {
    setSending(true);
    try {
      await streamScrape('/api/outreach/send', {}, 'Sending outreach emails...');
    } finally {
      setSending(false);
      await load();
    }
  }

  async function handleStopSend() {
    try { await fetch('/api/outreach/send/stop', { method: 'POST' }); } catch {}
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

  const stats = {
    total: contacts.length,
    pending: contacts.filter(c => c.status === 'pending').length,
    sent: contacts.filter(c => c.status === 'sent').length,
    interested: contacts.filter(c => c.replyStatus === 'interested').length,
    rejected: contacts.filter(c => c.replyStatus === 'rejected').length,
  };

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

      {/* Bulk send CTA */}
      <div className="rounded-xl border border-yellow-700/40 bg-yellow-900/10 p-5">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-bold text-yellow-200 flex items-center gap-2">
              <Send size={14} /> Send to Pending Contacts
            </h2>
            <p className="text-xs text-yellow-100/60 mt-1">
              Rate-limited (20-45s between sends, capped per day) so your Gmail account doesn't get flagged. Generates a unique cover letter per company and attaches your resume.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={handleSend} disabled={busy || sending || stats.pending === 0}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-yellow-500 hover:bg-yellow-400
                text-black font-bold text-sm transition-colors disabled:opacity-40 shadow-lg">
              <Send size={14} className={sending ? 'animate-pulse' : ''} />
              {sending ? `Sending... (${stats.pending} pending)` : `Send to ${stats.pending} Pending`}
            </button>
            {sending && (
              <button onClick={handleStopSend}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500
                  text-white font-bold text-sm transition-colors shadow-lg">
                <X size={14} /> Stop
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Stats + reply check */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-6">
          <Stat label="Contacts" value={stats.total} color="text-sky-300" />
          <Stat label="Pending" value={stats.pending} color="text-gray-300" />
          <Stat label="Sent" value={stats.sent} color="text-blue-300" />
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
              {contacts.map((c) => (
                <tr key={c.email}>
                  <td className="px-4 py-2 text-[#e6edf3]">{c.companyName}</td>
                  <td className="px-4 py-2 text-[#8b949e]">{c.email}</td>
                  <td className="px-4 py-2">
                    <span className={CONFIDENCE_COLOR[c.confidence] || 'text-gray-400'}>{c.source}</span>
                  </td>
                  <td className="px-4 py-2">
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${STATUS_BADGE[c.status] || STATUS_BADGE.pending}`}>
                      {c.status}
                    </span>
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
