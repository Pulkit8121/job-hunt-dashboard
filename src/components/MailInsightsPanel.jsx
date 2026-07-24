'use client';
import { useState, useEffect, useCallback } from 'react';
import { Mail, Target, ClipboardList, RefreshCw } from 'lucide-react';

function MailCard({ insight }) {
  return (
    <div className="rounded-lg border border-[#30363d] bg-[#0d1117] p-3">
      <p className="text-sm font-medium text-[#e6edf3] truncate">{insight.subject || '(no subject)'}</p>
      <p className="text-xs text-[#8b949e] mt-0.5">{insight.from}</p>
      {insight.snippet && <p className="text-xs text-[#6e7681] mt-2 line-clamp-3">{insight.snippet}</p>}
      <p className="text-[10px] text-[#484f58] mt-2">
        {insight.receivedAt ? new Date(insight.receivedAt).toLocaleString() : ''}
      </p>
    </div>
  );
}

export default function MailInsightsPanel({ streamScrape, busy }) {
  const [insights, setInsights] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/mail-insights');
      const data = await res.json();
      setInsights(Array.isArray(data) ? data : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleScan() {
    setScanning(true);
    try {
      await streamScrape('/api/mail-insights/scan', { sinceDays: 30 }, 'Scanning inbox for job-related mail...');
    } finally {
      setScanning(false);
      await load();
    }
  }

  const positive = insights.filter(i => i.category === 'positive');
  const assessment = insights.filter(i => i.category === 'assessment');
  const other = insights.filter(i => i.category !== 'positive' && i.category !== 'assessment');

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-teal-700/40 bg-teal-900/10 p-5">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-bold text-teal-200 flex items-center gap-2">
              <Mail size={14} /> Mail Insights
            </h2>
            <p className="text-xs text-teal-100/60 mt-1">
              Scans your inbox (IMAP, read-only — same Gmail app password already used by outreach reply-checking, no separate webhook or key needed) for job-related mail and sorts it into interview/offer responses vs. assessment invites, so you don&apos;t have to dig through your inbox manually.
            </p>
          </div>
          <button onClick={handleScan} disabled={busy || scanning}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-teal-600 hover:bg-teal-500
              text-white font-bold text-sm transition-colors disabled:opacity-40 shadow-lg shrink-0">
            <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />
            {scanning ? 'Scanning inbox...' : 'Scan Inbox'}
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-[#8b949e]">Loading...</p>
      ) : insights.length === 0 ? (
        <div className="text-center py-16 text-[#8b949e]">
          <Mail size={40} className="mx-auto mb-4 opacity-20" />
          <p className="text-sm">No job-related mail found yet.</p>
          <p className="text-xs mt-2 opacity-60">Click &quot;Scan Inbox&quot; to check the last 30 days.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div>
            <h3 className="text-xs font-bold text-emerald-300 flex items-center gap-1.5 mb-3">
              <Target size={13} /> Positive Responses ({positive.length})
            </h3>
            <div className="space-y-2">
              {positive.length === 0 && <p className="text-xs text-[#484f58]">None yet.</p>}
              {positive.map(i => <MailCard key={i.messageId} insight={i} />)}
            </div>
          </div>
          <div>
            <h3 className="text-xs font-bold text-amber-300 flex items-center gap-1.5 mb-3">
              <ClipboardList size={13} /> Assessments / Tests ({assessment.length})
            </h3>
            <div className="space-y-2">
              {assessment.length === 0 && <p className="text-xs text-[#484f58]">None yet.</p>}
              {assessment.map(i => <MailCard key={i.messageId} insight={i} />)}
            </div>
          </div>
          {other.length > 0 && (
            <div className="lg:col-span-2">
              <h3 className="text-xs font-bold text-[#8b949e] mb-3">Other ({other.length})</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {other.map(i => <MailCard key={i.messageId} insight={i} />)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
