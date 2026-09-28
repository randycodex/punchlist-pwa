import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import AreaGroupList from '@/features/projects/AreaGroupList';
import { createArea, createProject } from '@/lib/db';

describe('project floor groups', () => {
  it('shows a non-unit area on its floor and an empty Roof above the selected levels', () => {
    const project = createProject('Tower');
    project.facadeLevelStart = 1;
    project.facadeLevelEnd = 3;
    const corridor = createArea(project.id, 'Corridor 3rd Floor', 0, {
      areaTypeKey: 'corridor',
      areaNumber: '3rd Floor',
    });
    const markup = renderToStaticMarkup(createElement(AreaGroupList, {
      areas: [corridor],
      projectLevelRange: project,
      renderArea: (area, nested) => createElement('span', { key: area.id, 'data-nested': nested ? 'true' : 'false' }, area.name),
    }));

    expect(markup.indexOf('Floor 3')).toBeGreaterThan(markup.indexOf('Floor 2'));
    expect(markup.indexOf('Roof')).toBeGreaterThan(markup.indexOf('Floor 3'));
    expect(markup).toContain('Corridor 3rd Floor');
    expect(markup).toContain('data-nested="true"');
    expect(markup).toContain('inspection-location-surface');
    expect(markup).toContain('0 areas');
    expect(markup.match(/Corridor 3rd Floor/g)).toHaveLength(1);

    const emptyProjectMarkup = renderToStaticMarkup(createElement(AreaGroupList, {
      areas: [],
      projectLevelRange: project,
      renderArea: (area) => createElement('span', { key: area.id }, area.name),
    }));
    expect(emptyProjectMarkup).toContain('Roof');
    expect(emptyProjectMarkup).toContain('No areas yet');
  });
  it('labels negative project levels as cellars', () => {
    const project = createProject('Tower');
    project.facadeLevelStart = -2;
    project.facadeLevelEnd = -1;
    const markup = renderToStaticMarkup(createElement(AreaGroupList, {
      areas: [],
      projectLevelRange: project,
      renderArea: (area) => createElement('span', { key: area.id }, area.name),
    }));

    expect(markup).toContain('Cellar 2');
    expect(markup).toContain('>Cellar</span>');
    expect(markup).not.toContain('Floor -');
  });
});
