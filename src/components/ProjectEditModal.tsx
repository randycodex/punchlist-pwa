'use client';

import { useState } from 'react';
import { Project } from '@/types';
import { X } from 'lucide-react';

interface ProjectEditModalProps {
  project: Project;
  onSave: (updates: Partial<Project>) => void;
  onDelete?: () => void;
  onClose: () => void;
}

export default function ProjectEditModal({ project, onSave, onDelete, onClose }: ProjectEditModalProps) {
  function toDateInputValue(value: Date) {
    const date = new Date(value);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().split('T')[0];
  }

  const [projectName, setProjectName] = useState(project.projectName);
  const [address, setAddress] = useState(project.address);
  const [inspector, setInspector] = useState(project.inspector);
  const [gcName, setGcName] = useState(project.gcName);
  const [facadeLevelStart, setFacadeLevelStart] = useState(project.facadeLevelStart?.toString() ?? '');
  const [facadeLevelEnd, setFacadeLevelEnd] = useState(project.facadeLevelEnd?.toString() ?? '');
  const [date, setDate] = useState(toDateInputValue(project.date));

  function handleSave() {
    if (!projectName.trim()) return;

    const nextFacadeLevelStart = Number.parseInt(facadeLevelStart, 10);
    const nextFacadeLevelEnd = Number.parseInt(facadeLevelEnd, 10);

    onSave({
      projectName: projectName.trim(),
      address: address.trim(),
      inspector: inspector.trim(),
      gcName: gcName.trim(),
      date: new Date(date),
      facadeLevelStart: Number.isNaN(nextFacadeLevelStart) ? undefined : nextFacadeLevelStart,
      facadeLevelEnd: Number.isNaN(nextFacadeLevelEnd) ? undefined : nextFacadeLevelEnd,
    });
  }

  return (
    <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="modal-panel max-h-[90vh] w-full max-w-md overflow-y-auto rounded-[1.9rem]">
        <div className="sticky sticky-surface top-0 flex items-center justify-between border-b px-5 py-4">
          <div>
            <h2 className="text-xl font-semibold tracking-[-0.02em] text-gray-900 dark:text-white">Edit Project</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Update project details and metadata.</p>
          </div>
          <button onClick={onClose} className="rounded-full p-2 text-gray-500 transition hover:bg-black/[0.04] hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/[0.05] dark:hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Project Name *
            </label>
            <input
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              className="field-shell"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Address
            </label>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="field-shell"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Inspection Date
            </label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="field-shell"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Inspector Name
            </label>
            <input
              type="text"
              value={inspector}
              onChange={(e) => setInspector(e.target.value)}
              className="field-shell"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              GC Name
            </label>
            <input
              type="text"
              value={gcName}
              onChange={(e) => setGcName(e.target.value)}
              className="field-shell"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
              Level Range
            </label>
            <div className="grid grid-cols-2 gap-3">
              <input
                type="number"
                value={facadeLevelStart}
                onChange={(e) => setFacadeLevelStart(e.target.value)}
                className="field-shell"
                placeholder="From"
              />
              <input
                type="number"
                value={facadeLevelEnd}
                onChange={(e) => setFacadeLevelEnd(e.target.value)}
                className="field-shell"
                placeholder="To"
              />
            </div>
          </div>
        </div>

        <div className="sticky sticky-surface bottom-0 space-y-3 border-t p-5">
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 rounded-2xl border border-gray-300/90 bg-white/70 px-4 py-3 font-medium text-gray-700 transition hover:bg-white dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!projectName.trim()}
              className="flex-1 rounded-2xl bg-zinc-900 px-4 py-3 font-medium text-white transition hover:bg-black disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
            >
              Save
            </button>
          </div>
          {onDelete && (
            <button
              onClick={onDelete}
              className="accent-text block w-full text-center text-sm font-medium transition hover:opacity-80"
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
