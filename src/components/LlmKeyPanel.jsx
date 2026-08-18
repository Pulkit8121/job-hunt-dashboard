'use client';
import { useState, useEffect, useCallback } from 'react';
import { KeyRound, Check, Loader2, AlertTriangle } from 'lucide-react';

// Lets the OpenAI key be swapped from the dashboard instead of by editing
// .env.local and restarting. At high apply volume a key can hit its rate limit
// or get rotated mid-run, and the fix shouldn't require a deploy.
export default function LlmKeyPanel() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/llm-settings');
      setState(await res.json());
    } catch {
      setError('Could not load LLM settings.');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function choose(id) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/llm-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activeKey: id }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error || 'Switch failed.');
      else setState(s => ({ ...s, ...body }));
    } catch {
      setError('Switch failed.');
    } finally {
      setBusy(false);
    }
  }

  if (!state) {
    return (
      <div className="rounded-xl border border-[#30363d] bg-[#161b22] p-4 text-xs text-[#8b949e]">
        Loading LLM settings…
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[#30363d] bg-[#161b22] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <KeyRound size={14} className="text-[#8b949e]" />
        <h3 className="text-sm font-semibold text-[#e6edf3]">OpenAI key</h3>
        <span className="ml-auto text-[10px] text-[#8b949e]">{state.openaiModel}</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {state.keys.map(k => {
          const active = k.id === state.activeKey;
          return (
            <button
              key={k.id}
              onClick={() => choose(k.id)}
              disabled={busy || !k.configured || active}
              className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                active
                  ? 'border-emerald-700/60 bg-emerald-900/25'
                  : k.configured
                    ? 'border-[#30363d] bg-[#0d1117] hover:border-[#8b949e]'
                    : 'border-[#30363d] bg-[#0d1117] opacity-50 cursor-not-allowed'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-[#e6edf3]">Key {k.id}</span>
                {active && <Check size={12} className="text-emerald-400" />}
                {busy && !active && <Loader2 size={12} className="animate-spin text-[#8b949e]" />}
              </div>
              <div className="text-[10px] text-[#8b949e] font-mono mt-0.5">
                {k.configured ? k.fingerprint : 'not set'}
              </div>
            </button>
          );
        })}
      </div>

      {error && (
        <p className="flex items-center gap-1.5 text-[11px] text-red-400">
          <AlertTriangle size={11} /> {error}
        </p>
      )}

      {/* A provider marked dead this process (bad key, exhausted quota) is why
          answers silently stop coming — surface it rather than letting the
          pipeline quietly fall back to deterministic-only answering. */}
      {state.disabled && Object.keys(state.disabled).length > 0 && (
        <p className="text-[11px] text-orange-400">
          Disabled this run: {Object.entries(state.disabled).map(([k, v]) => `${k} (${v})`).join(', ')}
        </p>
      )}

      <p className="text-[10px] text-[#6e7681] leading-4">
        Provider order: {state.providerOrder?.join(' → ')}. Switching keys re-enables OpenAI if it
        was disabled by a bad-key or quota error.
      </p>
    </div>
  );
}
