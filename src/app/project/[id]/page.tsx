'use client';

import { useState, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Project, getProjectStats, getAreaStats } from '@/types';
import { getProject, saveProject, createArea } from '@/lib/db';
import { applyTemplateToArea } from '@/lib/template';
import Link from 'next/link';
import {
  ArrowLeft,
  Plus,
  Building2,
  ChevronRight,
  Trash2,
  ChevronDown,
  CheckCircle,
  AlertTriangle,
  Circle,
  MapPin,
  User,
} from 'lucide-react';

type SortOption = 'name' | 'recent' | 'progress';

const SORT_STORAGE_KEY = 'punchlist-areas-sort';

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAddArea, setShowAddArea] = useState(false);
  const [deleteMode, setDeleteMode] = useState(false);
  const [selectedAreaIds, setSelectedAreaIds] = useState<Set<string>>(new Set());
  const [newAreaName, setNewAreaName] = useState('');
  const [sortOption, setSortOption] = useState<SortOption>('name');
  const [showSortMenu, setShowSortMenu] = useState(false);

  const sortLabels: Record<SortOption, string> = {
    name: 'Name',
    recent: 'Recent',
    progress: 'Progress',
  };

  useEffect(() => {
    if (!id) {
      router.push('/');
      return;
    }
    // Load saved sort preference
    const savedSort = localStorage.getItem(SORT_STORAGE_KEY) as SortOption;
    if (savedSort && ['name', 'recent', 'progress'].includes(savedSort)) {
      setSortOption(savedSort);
    }
    loadProject();
  }, [id]);

  function handleSortChange(option: SortOption) {
    setSortOption(option);
    localStorage.setItem(SORT_STORAGE_KEY, option);
    setShowSortMenu(false);
  }

  async function loadProject() {
    if (!id) return;
    try {
      const data = await getProject(id);
      if (data) {
        setProject(data);
      } else {
        router.push('/');
      }
    } catch (error) {
      console.error('Failed to load project:', error);
      router.push('/');
    } finally {
      setLoading(false);
    }
  }

  const sortedAreas = project?.areas
    ? [...project.areas].sort((a, b) => {
        if (sortOption === 'name') {
          return a.name.localeCompare(b.name);
        } else if (sortOption === 'recent') {
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        } else {
          const statsA = getAreaStats(a);
          const statsB = getAreaStats(b);
          const progressA = statsA.total > 0 ? statsA.ok / statsA.total : 0;
          const progressB = statsB.total > 0 ? statsB.ok / statsB.total : 0;
          return progressB - progressA;
        }
      })
    : [];

  async function handleAddArea() {
    if (!project || !newAreaName.trim()) return;

    const area = createArea(project.id, newAreaName.trim(), project.areas.length);
    applyTemplateToArea(area);
    project.areas.push(area);
    await saveProject(project);
    setNewAreaName('');
    setShowAddArea(false);
    loadProject();
  }

  function toggleAreaSelection(areaId: string) {
    setSelectedAreaIds((prev) => {
      const next = new Set(prev);
      if (next.has(areaId)) next.delete(areaId);
      else next.add(areaId);
      return next;
    });
  }

  async function handleDeleteSelectedAreas() {
    if (!project) return;
    if (selectedAreaIds.size === 0) {
      setDeleteMode(false);
      return;
    }
    if (!confirm(`Delete ${selectedAreaIds.size} selected area(s)?`)) return;
    project.areas = project.areas.filter((area) => !selectedAreaIds.has(area.id));
    await saveProject(project);
    setSelectedAreaIds(new Set());
    setDeleteMode(false);
    await loadProject();
  }

  function cancelSelectionMode() {
    setDeleteMode(false);
    setSelectedAreaIds(new Set());
  }

  if (loading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!project) {
    return null;
  }

  const stats = getProjectStats(project);

  return (
    <div className="min-h-[100dvh] bg-gray-50 dark:bg-gray-900 pb-[env(safe-area-inset-bottom)]">
      {/* Header controls */}
      <header className="header-stable bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 sticky top-[calc(env(safe-area-inset-top)+3.5rem)] z-20">
        <div className="pl-2 pr-3 h-12 flex items-center gap-2">
          <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
            <Link href="/" className="p-1 -ml-1 text-gray-600 dark:text-gray-300">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <span className="font-medium text-gray-700 dark:text-gray-200 truncate">
              {project.projectName}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300 shrink-0">
            <div className="relative">
              <button
                onClick={() => setShowSortMenu(!showSortMenu)}
                className="h-9 flex items-center justify-between gap-1 min-w-[6.5rem] px-3 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
              >
                {sortLabels[sortOption]}
                <ChevronDown className="w-4 h-4" />
              </button>
              {showSortMenu && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setShowSortMenu(false)}
                  />
                  <div className="absolute right-0 mt-1 w-36 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-20">
                    {(['name', 'recent', 'progress'] as SortOption[]).map((option) => (
                      <button
                        key={option}
                        onClick={() => handleSortChange(option)}
                        className={`w-full px-4 py-2 text-left text-sm hover:bg-gray-50 dark:hover:bg-gray-700 ${
                          sortOption === option ? 'text-blue-600 font-medium' : 'text-gray-700 dark:text-gray-300'
                        }`}
                      >
                        {sortLabels[option]}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button
              onClick={() => {
                if (deleteMode) {
                  void handleDeleteSelectedAreas();
                } else {
                  setDeleteMode(true);
                  setSelectedAreaIds(new Set());
                }
              }}
              className={`h-9 w-9 flex items-center justify-center rounded-lg ${
                deleteMode
                  ? 'text-red-600 bg-red-50 dark:bg-red-900/20'
                  : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
              aria-label="Select areas to delete"
            >
              <Trash2 className="w-4 h-4" />
            </button>
            <div className="w-[4.75rem] flex justify-end">
              {deleteMode ? (
                <button
                  onClick={cancelSelectionMode}
                  className="h-9 px-3 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
                >
                  Cancel
                </button>
              ) : null}
            </div>
            <button
              onClick={() => setShowAddArea(true)}
              className="h-9 w-9 flex items-center justify-center text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded-lg"
              aria-label="Add area"
            >
              <Plus className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Project Info */}
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        {project.address && (
          <p className="text-sm text-gray-600 dark:text-gray-400 flex items-center gap-1 mb-2">
            <MapPin className="w-4 h-4" />
            {project.address}
          </p>
        )}
        {project.inspector && (
          <p className="text-sm text-gray-600 dark:text-gray-400 flex items-center gap-1 mb-2">
            <User className="w-4 h-4" />
            {project.inspector}
          </p>
        )}
        <div className="flex items-center gap-6 mt-3">
          <div className="text-center">
            <div className="text-2xl font-semibold text-purple-600">{stats.areas}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">Areas</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-semibold text-blue-600">{stats.total}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">Total</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-semibold text-green-600">{stats.ok}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">OK</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-semibold text-orange-500">{stats.issues}</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">Issues</div>
          </div>
        </div>
      </div>

      {/* Areas List */}
      <main className="p-4">
        {project.areas.length === 0 ? (
          <div className="text-center py-12">
            <Building2 className="w-16 h-16 mx-auto text-gray-300 dark:text-gray-600 mb-4" />
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mb-2">No Areas</h2>
            <p className="text-gray-500 dark:text-gray-400 mb-4">Add an area to start inspecting</p>
            <button
              onClick={() => setShowAddArea(true)}
              className="px-4 py-2 bg-blue-500 text-white rounded-lg font-medium hover:bg-blue-600"
            >
              Add Area
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {sortedAreas.map((area) => {
              const areaStats = getAreaStats(area);
              const pending = areaStats.total - areaStats.ok - areaStats.issues;
              const progress =
                areaStats.total > 0 ? (areaStats.ok / areaStats.total) * 100 : 0;
              return (
                <div
                  key={area.id}
                  className="block bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 hover:border-blue-300 dark:hover:border-blue-600 transition-colors"
                >
                  <div className="flex items-start gap-3">
                    {deleteMode && (
                      <input
                        type="checkbox"
                        checked={selectedAreaIds.has(area.id)}
                        onChange={() => toggleAreaSelection(area.id)}
                        className="mt-0.5 h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        aria-label={`Select ${area.name}`}
                      />
                    )}
                    <Link
                      href={deleteMode ? '#' : `/project/${project.id}/area/${area.id}`}
                      onClick={(e) => {
                        if (deleteMode) e.preventDefault();
                      }}
                      className="flex-1"
                    >
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium text-gray-900 dark:text-white">{area.name}</h3>
                        {area.isComplete && (
                          <CheckCircle className="w-4 h-4 text-green-500" />
                        )}
                      </div>
                      <div className="flex items-center gap-4 mt-2 text-sm">
                        <span className="text-gray-500 dark:text-gray-400">{areaStats.total} items</span>
                        {areaStats.ok > 0 && (
                          <span className="text-green-600 flex items-center gap-1">
                            <CheckCircle className="w-3 h-3" />
                            {areaStats.ok}
                          </span>
                        )}
                        {areaStats.issues > 0 && (
                          <span className="text-orange-500 flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" />
                            {areaStats.issues}
                          </span>
                        )}
                        {pending > 0 && (
                          <span className="text-gray-400 flex items-center gap-1">
                            <Circle className="w-3 h-3" />
                            {pending}
                          </span>
                        )}
                      </div>
                      {areaStats.total > 0 && (
                        <div className="mt-2 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-green-500 transition-all"
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                      )}
                    </Link>
                    <Link
                      href={deleteMode ? '#' : `/project/${project.id}/area/${area.id}`}
                      onClick={(e) => {
                        if (deleteMode) e.preventDefault();
                      }}
                      className="p-1 text-gray-400 hover:text-blue-500"
                      aria-label={`Open ${area.name}`}
                    >
                      <ChevronRight className="w-5 h-5 text-gray-400" />
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* Add Area Modal */}
      {showAddArea && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white dark:bg-gray-800 rounded-xl w-full max-w-md p-6">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Add Area</h2>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Area Name *
              </label>
              <input
                type="text"
                value={newAreaName}
                onChange={(e) => setNewAreaName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                placeholder="e.g., Apt 101, Unit A"
                autoFocus
              />
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => {
                  setShowAddArea(false);
                  setNewAreaName('');
                }}
                className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                Cancel
              </button>
              <button
                onClick={handleAddArea}
                disabled={!newAreaName.trim()}
                className="flex-1 px-4 py-2 bg-blue-500 text-white rounded-lg font-medium hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
