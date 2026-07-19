'use client';

import { AlertTriangle, Camera, type LucideIcon } from 'lucide-react';

function formatPart(value: number, singular: string, plural: string) {
  return `${value} ${value === 1 ? singular : plural}`;
}

export default function MetadataLine({
  issues = 0,
  notes = 0,
  photos = 0,
  issuesOnly = false,
  className = '',
}: {
  issues?: number;
  notes?: number;
  photos?: number;
  issuesOnly?: boolean;
  className?: string;
}) {
  // `notes` kept in the API for call-site compatibility; list UI stays minimal.
  void notes;

  const parts: Array<{ key: string; text: string; className: string; icon: LucideIcon }> = [];

  if (issues > 0) {
    parts.push({
      key: 'issues',
      text: formatPart(issues, 'issue', 'issues'),
      className: 'accent-text',
      icon: AlertTriangle,
    });
  }

  if (!issuesOnly && photos > 0) {
    parts.push({
      key: 'photos',
      text: formatPart(photos, 'photo', 'photos'),
      className: 'metric-secondary',
      icon: Camera,
    });
  }

  if (parts.length === 0) return null;

  return (
    <div className={`metric-line text-sm ${className}`.trim()}>
      {parts.map((part) => {
        const Icon = part.icon;
        return (
          <span key={part.key} className={`${part.className} inline-flex items-center gap-1.5`}>
            <Icon className="h-3.5 w-3.5 opacity-80" />
            {part.text}
          </span>
        );
      })}
    </div>
  );
}
