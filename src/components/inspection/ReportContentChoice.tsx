'use client';

export default function ReportContentChoice({ value, onChange }: { value: 'issues' | 'full'; onChange: (value: 'issues' | 'full') => void }) {
  return <fieldset className="mx-2 mb-3 space-y-2 rounded-xl bg-black/[0.03] p-3 text-left text-sm dark:bg-white/[0.04]">
    <legend className="px-1 font-semibold">Report contents</legend>
    <label className="flex min-h-11 items-center gap-3"><input type="radio" name="report-content" checked={value === 'issues'} onChange={() => onChange('issues')} /><span>Issues report <span className="block text-xs text-gray-500 dark:text-gray-400">Flagged issues and their evidence</span></span></label>
    <label className="flex min-h-11 items-center gap-3"><input type="radio" name="report-content" checked={value === 'full'} onChange={() => onChange('full')} /><span>Inspection record <span className="block text-xs text-gray-500 dark:text-gray-400">All checkpoints, observations, and photos</span></span></label>
    <p className="text-xs text-gray-500 dark:text-gray-400">Uses the record on this device. Get Team Updates first when you need the latest team report.</p>
  </fieldset>;
}
