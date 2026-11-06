import { getCheckpointIssueState, type Checkpoint } from '@/types';

type IssueChange = Pick<Checkpoint, 'status' | 'issueState' | 'fixStatus'>;

/** New inspection evidence opens an issue without resetting an existing resolution. */
export function getCapturedIssueChange(
  checkpoint: Pick<Checkpoint, 'status' | 'issueState' | 'fixStatus'>,
  capture: { hasNewPhoto?: boolean; hasNewNote?: boolean },
): Partial<IssueChange> {
  if ((!capture.hasNewPhoto && !capture.hasNewNote) || getCheckpointIssueState(checkpoint) !== 'none') {
    return {};
  }
  return { status: 'needsReview', issueState: 'open', fixStatus: 'pending' };
}
