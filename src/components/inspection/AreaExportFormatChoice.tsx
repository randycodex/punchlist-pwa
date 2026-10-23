'use client';

import type { AreaExportFormat } from '@/features/export/selectedAreaExport';

export default function AreaExportFormatChoice({ value, onChange, disabled = false }: {
  value: AreaExportFormat;
  onChange: (value: AreaExportFormat) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="mx-2 mb-3 space-y-2 rounded-xl bg-black/[0.03] p-3 text-left text-sm dark:bg-white/[0.04]">
      <legend className="px-1 font-semibold">PDF files</legend>
      <label className="flex min-h-11 items-center gap-3">
        <input type="radio" name="area-export-format" checked={value === 'combined'} onChange={() => onChange('combined')} />
        <span>One combined PDF<span className="block text-xs text-gray-500 dark:text-gray-400">All selected areas in one report</span></span>
      </label>
      <label className="flex min-h-11 items-center gap-3">
        <input type="radio" name="area-export-format" checked={value === 'individual'} onChange={() => onChange('individual')} />
        <span>One PDF per area (ZIP)<span className="block text-xs text-gray-500 dark:text-gray-400">One ZIP containing a separate PDF for each selected area</span></span>
      </label>
    </fieldset>
  );
}
