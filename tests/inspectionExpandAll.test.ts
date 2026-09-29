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
    getRecentComments: () => [],
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

  it('shows only the opened checkpoint’s saved suggestions', () => {
    const source = fixture('Entry / Foyer', 'Entry Door');
    const [door, finish] = source.item.checkpoints;
    door.comments = 'Scratch on door';
    const getRecentComments = (checkpoint: typeof door) =>
      checkpoint.id === door.id ? ['Door-only suggestion'] : ['Finish-only suggestion'];

    const doorMarkup = renderCard(source, {
      expandedCheckpointId: door.id,
      getRecentComments,
    });
    expect(doorMarkup).toContain('Door-only suggestion');
    expect(doorMarkup).toMatch(/segmented-chip[^>]*>Scratch on door<\/button>/);
    expect(doorMarkup).not.toContain('Finish-only suggestion');

    const finishMarkup = renderCard(source, {
      expandedCheckpointId: finish.id,
      getRecentComments,
    });
    expect(finishMarkup).toContain('Finish-only suggestion');
    expect(finishMarkup).not.toContain('Door-only suggestion');
  });
});
