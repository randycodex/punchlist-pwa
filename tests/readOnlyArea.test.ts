import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ReadOnlyArea from '@/components/inspection/ReadOnlyArea';
import PhotoCapture from '@/components/PhotoCapture';
import type { Area } from '@/types';

const photo = { id: 'photo', checkpointId: 'checkpoint', imageData: 'data:image/png;base64,AAAA', createdAt: new Date() };
const file = { id: 'file', checkpointId: 'checkpoint', name: 'inspection.pdf', data: 'data:application/pdf;base64,AAAA', mimeType: 'application/pdf', size: 3, createdAt: new Date() };
const noop = () => {};

describe('locked area viewing', () => {
  it('exposes expandable saved contents without editing controls', () => {
    const area = { notes: 'Area note', locations: [{ id: 'room', name: 'Bedroom', items: [{ id: 'item', name: 'Walls', checkpoints: [{ id: 'checkpoint', name: 'Finish', status: 'ok', comments: 'Saved note', photos: [photo], files: [file] }] }] }] } as unknown as Area;
    const html = renderToStaticMarkup(createElement(ReadOnlyArea, { area }));
    expect(html).toContain('<summary');
    expect(html).toContain('Bedroom');
    expect(html).toContain('Walls');
    expect(html).toContain('Saved note');
    expect(html).toContain('Area note');
    expect(html).toContain('inspection.pdf');
    expect(html).toContain('Checkpoint photo');
    expect(html).not.toMatch(/<textarea|<select|<button/);
    expect(html).toMatch(/<input[^>]*disabled/);
  });
  it('retains media editing controls for editable areas', () => {
    const html = renderToStaticMarkup(createElement(PhotoCapture, { photos: [photo], files: [file], onAddPhoto: noop, onDeletePhoto: noop, onDeleteFile: noop }));
    expect(html).toContain('Open photo library');
    expect(html).toContain('Delete inspection.pdf');
  });
});
