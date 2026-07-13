'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock } from 'lucide-react';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Login failed');
        return;
      }
      router.replace('/');
      router.refresh();
    } catch {
      setError('Something went wrong. Try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0d1117] px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm bg-[#161b22] border border-[#30363d] rounded-xl p-8 space-y-5">
        <div className="flex flex-col items-center gap-2 mb-2">
          <div className="w-10 h-10 rounded-full bg-blue-900/40 border border-blue-700/40 flex items-center justify-center">
            <Lock size={18} className="text-blue-300" />
          </div>
          <h1 className="text-lg font-semibold text-[#e6edf3]">Job Hunt Dashboard</h1>
          <p className="text-sm text-[#8b949e]">Sign in to continue</p>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-[#8b949e]">Email</label>
          <input
            type="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md bg-[#0d1117] border border-[#30363d] px-3 py-2 text-sm text-[#e6edf3] focus:outline-none focus:border-blue-600"
            placeholder="you@example.com"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-[#8b949e]">Password</label>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md bg-[#0d1117] border border-[#30363d] px-3 py-2 text-sm text-[#e6edf3] focus:outline-none focus:border-blue-600"
            placeholder="••••••••"
          />
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white text-sm font-medium py-2 transition-colors"
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
