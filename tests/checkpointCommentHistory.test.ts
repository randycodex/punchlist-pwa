import { describe, expect, it } from 'vitest';
import {
  getCheckpointRecentComments,
  parseCheckpointCommentHistory,
  rememberCheckpointComment,
} from '@/features/inspection/checkpointCommentHistory';

describe('checkpoint comment suggestions', () => {
  it('keeps notes separate by project and checkpoint after storage reload', () => {
    let history = rememberCheckpointComment({}, 'project-a', 'door', 'Scratch on door');
    history = rememberCheckpointComment(history, 'project-a', 'paint', 'Paint touch-up');
    history = rememberCheckpointComment(history, 'project-b', 'door', 'Other project note');
    history = parseCheckpointCommentHistory(JSON.stringify(history));

    expect(getCheckpointRecentComments(history, 'project-a', 'door')).toEqual(['Scratch on door']);
    expect(getCheckpointRecentComments(history, 'project-a', 'paint')).toEqual(['Paint touch-up']);
    expect(getCheckpointRecentComments(history, 'project-b', 'door')).toEqual(['Other project note']);
    expect(getCheckpointRecentComments(history, 'project-b', 'paint')).toEqual([]);
  });

  it('keeps the five most recent distinct notes for one checkpoint', () => {
    let history = {};
    for (const comment of ['one', 'two', 'three', 'four', 'five', 'six', 'two']) {
      history = rememberCheckpointComment(history, 'project', 'door', comment);
    }
    expect(getCheckpointRecentComments(history, 'project', 'door'))
      .toEqual(['two', 'six', 'five', 'four', 'three']);
  });
});
