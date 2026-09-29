import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createArea, createCheckpoint, createItem, createLocation, createProject } from '@/lib/db';
import InspectionLocationCard from '@/components/inspection/InspectionLocationCard';
import { createElement, type ComponentProps } from 'react';

function fixture(locationName: string, itemName: string, custom = false) {
  const project = createProject('Expansion test');
  const area = createArea(project.id, 'Area', 0);
  const location = createLocation(area.id, locationName, 0);
  const item = createItem(location.id, itemName, 0);
  item.isCustom = custom;
  item.checkpoints.push(createCheckpoint(item.id, 'Paint', 0));
  if (!custom) item.checkpoints.push(createCheckpoint(item.id, 'Finish', 1));
  location.items.push(item);
  return { project, location, item };
}

function renderCard(
  source: ReturnType<typeof fixture>,
  overrides: Partial<ComponentProps<typeof InspectionLocationCard>> = {}
) {
  const props: ComponentProps<typeof InspectionLocationCard> = {
    projectId: source.project.id,
    location: source.location,
    itemMetrics: new Map(),
    expandedItems: new Set([source.item.id]),
    isExpanded: true,
    onToggleLocation: () => {},
    onToggleItem: () => {},
    onToggleCheckpoint: () => {},
    onCommentChange: () => {},
    onCommentBlur: () => {},
    onUpdateCheckpointStatus: () => {},
    expandedCheckpointId: null,
    commentText: '',
    recentComments: [],
    onCreatePhotoCheckpoint: async () => ({ id: 'new', name: 'New' }),
    onDropPhotos: async () => {},
    onUndoDroppedPhotos: async () => {},
    onAddPhoto: () => {},
    onAddPhotos: () => {},
    onAddFiles: () => {},
    onDeletePhoto: () => {},
    onDeleteFile: () => {},
    registerItemRef: () => {},
    ...overrides,
  };
  return renderToStaticMarkup(createElement(InspectionLocationCard, props));
}

function editorCount(markup: string) {
  return (markup.match(/<textarea\b/g) ?? []).length;
}

describe('inspection Expand all', () => {
  it('opens every visible Paint checkpoint and lets one be collapsed', () => {
    const source = fixture('Living room', 'Paint');
    expect(editorCount(renderCard(source))).toBe(0);
    expect(editorCount(renderCard(source, { expandAllCheckpoints: true }))).toBe(2);
    expect(editorCount(renderCard(source, {
      expandAllCheckpoints: true,
      collapsedCheckpointIds: new Set([source.item.checkpoints[0].id]),
    }))).toBe(1);
  });

  it('also opens checkpoints in flattened and custom item rows', () => {
    expect(editorCount(renderCard(fixture('Paint', 'Paint'), { expandAllCheckpoints: true }))).toBe(2);
    expect(editorCount(renderCard(fixture('Custom Items', 'Custom item', true), {
      expandAllCheckpoints: true,
      alwaysExpanded: true,
      hideHeader: true,
    }))).toBe(1);
  });
});
