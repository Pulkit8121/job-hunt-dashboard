'use client';
import { useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { ATS_TYPES, COMPANY_TYPES, DIFFICULTIES, WORK_MODES } from '@/lib/company-utils';

const TYPE_LABELS = {
  'easy-mnc': 'Easy MNC',
  'remote-mnc': 'Remote MNC',
  hard: 'Hard',
  startup: 'Startup',
  unknown: 'Unknown',
};

const DIFFICULTY_LABELS = {
  easy: 'Easy',
  moderate: 'Moderate',
  hard: 'Hard',
};

function formatLabel(value) {
  return value
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export default function AddCompanyModal({ onClose, onAdded }) {
  const [form, setForm] = useState({
    name: '',
    type: 'unknown',
    workMode: 'unknown',
    difficulty: '',
    interviewNote: '',
    locations: 'Bengaluru',
    careersUrl: '',
    naukriSearchUrl: '',
    wellfoundUrl: '',
    linkedinCompanyName: '',
    salaryRange: '12+ LPA',
    atsType: 'naukri',
    atsSlug: '',
  });
  const [loading, setLoading] = useState(false);
  const [autofilling, setAutofilling] = useState(false);
  const [error, setError] = useState('');
  const [helperMessage, setHelperMessage] = useState('');

  const set = (key, value) => setForm(current => ({ ...current, [key]: value }));

  async function handleAutofill() {
    if (!form.name.trim()) {
      setError('Enter a company name first so I can fill the basics.');
      return;
    }

    setAutofilling(true);
    setError('');
    setHelperMessage('');

    try {
      const res = await fetch('/api/companies/autofill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.name }),
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to auto-fill company details');
      }

      setForm(current => ({
        ...current,
        ...data.company,
        locations: Array.isArray(data.company.locations) ? data.company.locations.join(', ') : current.locations,
      }));
      setHelperMessage(data.message || 'Fields filled from the company name.');
    } catch (e) {
      setError(e.message);
    } finally {
      setAutofilling(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          locations: form.locations.split(',').map(location => location.trim()).filter(Boolean),
          linkedinCompanyName: form.linkedinCompanyName || form.name,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to add company');
      }

      const company = await res.json();
      onAdded(company);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-[#161b22] border border-[#30363d] rounded-2xl w-full max-w-2xl mx-4 shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#30363d]">
          <div>
            <h2 className="text-base font-semibold text-[#e6edf3]">Add Company</h2>
            <p className="text-xs text-[#8b949e] mt-0.5">Use auto-fill for the basics, then tweak anything you want.</p>
          </div>
          <button onClick={onClose} className="text-[#8b949e] hover:text-[#e6edf3] transition-colors">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-4 space-y-3 max-h-[75vh] overflow-y-auto">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 items-end">
            <Field label="Company Name *">
              <input
                required
                value={form.name}
                onChange={e => set('name', e.target.value)}
                className="input-field"
                placeholder="e.g. Zepto"
              />
            </Field>

            <button
              type="button"
              onClick={handleAutofill}
              disabled={autofilling}
              className="h-[38px] px-3 rounded-lg border border-[#30363d] bg-[#21262d] text-sm text-[#8b949e]
                hover:text-[#e6edf3] hover:bg-[#30363d] transition-colors disabled:opacity-50 flex items-center gap-1.5"
            >
              <Sparkles size={14} className={autofilling ? 'animate-pulse text-yellow-400' : ''} />
              {autofilling ? 'Filling...' : 'Auto Fill'}
            </button>
          </div>

          {helperMessage && <p className="text-xs text-emerald-400">{helperMessage}</p>}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Type *">
              <select value={form.type} onChange={e => set('type', e.target.value)} className="input-field">
                {COMPANY_TYPES.map(type => (
                  <option key={type} value={type}>{TYPE_LABELS[type] || type}</option>
                ))}
              </select>
            </Field>

            <Field label="Work Mode *">
              <select value={form.workMode} onChange={e => set('workMode', e.target.value)} className="input-field">
                {WORK_MODES.map(mode => (
                  <option key={mode} value={mode}>{formatLabel(mode)}</option>
                ))}
              </select>
            </Field>

            <Field label="Interview Level">
              <select value={form.difficulty} onChange={e => set('difficulty', e.target.value)} className="input-field">
                <option value="">Not set</option>
                {DIFFICULTIES.map(level => (
                  <option key={level} value={level}>{DIFFICULTY_LABELS[level] || level}</option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Interview Note">
            <textarea
              value={form.interviewNote}
              onChange={e => set('interviewNote', e.target.value)}
              className="input-field min-h-20 resize-y"
              placeholder="What makes the interview easier, moderate, or tough?"
            />
          </Field>

          <Field label="Locations (comma separated)">
            <input
              value={form.locations}
              onChange={e => set('locations', e.target.value)}
              className="input-field"
              placeholder="Bengaluru, Hyderabad"
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Careers Page URL">
              <input
                value={form.careersUrl}
                onChange={e => set('careersUrl', e.target.value)}
                className="input-field"
                placeholder="https://company.com/careers"
              />
            </Field>

            <Field label="Naukri Search URL">
              <input
                value={form.naukriSearchUrl}
                onChange={e => set('naukriSearchUrl', e.target.value)}
                className="input-field"
                placeholder="https://www.naukri.com/company-jobs"
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Wellfound URL">
              <input
                value={form.wellfoundUrl}
                onChange={e => set('wellfoundUrl', e.target.value)}
                className="input-field"
                placeholder="https://wellfound.com/company/company/jobs"
              />
            </Field>

            <Field label="LinkedIn Company Name">
              <input
                value={form.linkedinCompanyName}
                onChange={e => set('linkedinCompanyName', e.target.value)}
                className="input-field"
                placeholder="Company name for LinkedIn search"
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="ATS Type">
              <select value={form.atsType} onChange={e => set('atsType', e.target.value)} className="input-field">
                {ATS_TYPES.map(type => (
                  <option key={type} value={type}>{formatLabel(type)}</option>
                ))}
              </select>
            </Field>

            <Field label="ATS Slug">
              <input
                value={form.atsSlug}
                onChange={e => set('atsSlug', e.target.value)}
                className="input-field"
                placeholder="company-slug"
              />
            </Field>

            <Field label="Salary Range">
              <input
                value={form.salaryRange}
                onChange={e => set('salaryRange', e.target.value)}
                className="input-field"
                placeholder="12-25 LPA"
              />
            </Field>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 rounded-lg border border-[#30363d] text-sm text-[#8b949e] hover:text-[#e6edf3] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="flex-1 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-medium transition-colors disabled:opacity-50"
            >
              {loading ? 'Adding...' : 'Add Company'}
            </button>
          </div>
        </form>
      </div>

      <style jsx>{`
        .input-field {
          width: 100%;
          background: #0d1117;
          border: 1px solid #30363d;
          border-radius: 0.5rem;
          padding: 0.4rem 0.75rem;
          color: #e6edf3;
          font-size: 0.875rem;
          outline: none;
        }
        .input-field:focus { border-color: #58a6ff; }
        .input-field::placeholder { color: #484f58; }
        option { background: #0d1117; }
      `}</style>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs text-[#8b949e] mb-1">{label}</label>
      {children}
    </div>
  );
}
