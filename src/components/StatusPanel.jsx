'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { Activity, RefreshCw, Clock, CheckCircle2, XCircle, PauseCircle, Loader2 } from 'lucide-react';

const POLL_MS = 8000;

function resultBadge(running, lastResult) {
  if (running) return { text: 'Running', className: 'bg-yellow-900/40 text-yellow-300 border-yellow-700/50', Icon: Loader2, spin: true };
  if (lastResult === 'success') return { text: 'OK', className: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50', Icon: CheckCircle2 };
  if (lastResult === 'fatal') return { text: 'Failed', className: 'bg-red-900/40 text-red-300 border-red-700/50', Icon: XCircle };
  if (lastResult === 'stopped') return { text: 'Stopped', className: 'bg-orange-900/40 text-orange-300 border-orange-700/50', Icon: PauseCircle };
  return { text: 'No runs yet', className: 'bg-[#21262d] text-[#8b949e] border-[#30363d]', Icon: Clock };
}

function timeAgo(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function PipelineCard({ p }) {
  const badge = resultBadge(p.running, p.lastResult);
  return (
    <div className="rounded-xl border border-[#30363d] bg-[#161b22] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[#e6edf3]">{p.label}</h3>
        <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] border ${badge.className}`}>
          <badge.Icon size={10} className={badge.spin ? 'animate-spin' : ''} />
          {badge.text}
        </span>
      </div>
      <p className="text-xs text-[#8b949e] leading-5 line-clamp-2" title={p.lastMessage || ''}>
        {p.lastMessage || 'No activity logged yet.'}
      </p>
      <div className="flex items-center justify-between text-[11px] text-[#484f58] pt-1 border-t border-[#21262d]">
        <span>Last run: {p.lastStartedAt ? new Date(p.lastStartedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'} ({timeAgo(p.lastStartedAt)})</span>
        <span>Cron: {p.cron}</span>
      </div>
    </div>
  );
}

export default function StatusPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/status');
      const json = await res.json();
      setData(json);
    } catch {
      // keep showing last-known state on a transient fetch failure
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, POLL_MS);
    return () => clearInterval(timerRef.current);
  }, [load]);

  if (loading && !data) {
    return (
      <div className="flex items-center gap-2 text-sm text-[#8b949e] py-10 justify-center">
        <Loader2 size={16} className="animate-spin" /> Loading live status...
      </div>
    );
  }

  const runningCount = (data?.pipelines || []).filter(p => p.running).length;

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-cyan-700/40 bg-cyan-900/10 p-5">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-sm font-bold text-cyan-200 flex items-center gap-2">
              <Activity size={14} /> Live Pipeline Status
            </h2>
            <p className="text-xs text-cyan-100/60 mt-1">
              Auto-refreshes every 8s. Only one pipeline runs at a time on purpose — the server has a single CPU core, so concurrent runs slow everything down rather than speeding results up.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            {runningCount > 0 && (
              <span className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-yellow-900/40 text-yellow-300 border border-yellow-700/50">
                <Loader2 size={11} className="animate-spin" /> {runningCount} running
              </span>
            )}
            <button onClick={load} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#21262d] hover:bg-[#30363d] text-xs text-[#8b949e] hover:text-[#e6edf3] border border-[#30363d] transition-colors">
              <RefreshCw size={12} /> Refresh now
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {(data?.pipelines || []).map(p => <PipelineCard key={p.id} p={p} />)}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="rounded-xl border border-[#30363d] bg-[#161b22] p-4">
          <h3 className="text-sm font-semibold text-[#e6edf3] mb-3">Applied — by source</h3>
          <div className="space-y-2">
            {Object.entries(data?.appliedTotals?.bySource || {}).map(([source, count]) => (
              <div key={source} className="flex items-center justify-between text-xs">
                <span className="text-[#8b949e] capitalize">{source}</span>
                <span className="text-[#e6edf3] font-medium">{count}</span>
              </div>
            ))}
            <div className="flex items-center justify-between text-xs pt-2 border-t border-[#21262d]">
              <span className="text-[#e6edf3] font-semibold">Total</span>
              <span className="text-emerald-300 font-bold">{data?.appliedTotals?.total ?? 0}</span>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-[#30363d] bg-[#161b22] p-4">
          <h3 className="text-sm font-semibold text-[#e6edf3] mb-3">Outreach contacts</h3>
          <div className="space-y-2 text-xs">
            <div className="flex items-center justify-between"><span className="text-[#8b949e]">Total</span><span className="text-[#e6edf3] font-medium">{data?.outreachStats?.total ?? 0}</span></div>
            <div className="flex items-center justify-between"><span className="text-[#8b949e]">Pending</span><span className="text-[#e6edf3] font-medium">{data?.outreachStats?.pending ?? 0}</span></div>
            <div className="flex items-center justify-between"><span className="text-[#8b949e]">Sent</span><span className="text-emerald-300 font-medium">{data?.outreachStats?.sent ?? 0}</span></div>
            <div className="flex items-center justify-between"><span className="text-[#8b949e]">Bounced</span><span className="text-red-300 font-medium">{data?.outreachStats?.bounced ?? 0}</span></div>
          </div>
        </div>
      </div>

      {data?.generatedAt && (
        <p className="text-[10px] text-[#484f58] text-right">
          Updated {new Date(data.generatedAt).toLocaleTimeString('en-IN')}
        </p>
      )}
    </div>
  );
}
