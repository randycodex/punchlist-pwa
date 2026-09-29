export const CHECKPOINT_COMMENT_HISTORY_STORAGE_KEY = 'punchlist-recent-checkpoint-comments';

const MAX_COMMENTS_PER_CHECKPOINT = 5;
const MAX_CHECKPOINT_HISTORIES = 250;

export type CheckpointCommentHistory = Record<string, string[]>;

function historyKey(projectId: string, checkpointId: string) {
  return `${projectId}:${checkpointId}`;
}

export function parseCheckpointCommentHistory(value: string | null): CheckpointCommentHistory {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const history: CheckpointCommentHistory = {};
    for (const [key, comments] of Object.entries(parsed).slice(-MAX_CHECKPOINT_HISTORIES)) {
      if (!key.includes(':')) continue;
      if (!Array.isArray(comments)) continue;
      const validComments = comments
        .filter((comment): comment is string => typeof comment === 'string')
        .map((comment) => comment.trim())
        .filter(Boolean);
      if (validComments.length > 0) {
        history[key] = [...new Set(validComments)].slice(0, MAX_COMMENTS_PER_CHECKPOINT);
      }
    }
    return history;
  } catch {
    return {};
  }
}

export function getCheckpointRecentComments(
  history: CheckpointCommentHistory,
  projectId: string,
  checkpointId: string
) {
  return history[historyKey(projectId, checkpointId)] ?? [];
}

export function rememberCheckpointComment(
  history: CheckpointCommentHistory,
  projectId: string,
  checkpointId: string,
  value: string
): CheckpointCommentHistory {
  const comment = value.trim();
  if (!comment) return history;

  const key = historyKey(projectId, checkpointId);
  const recent = [comment, ...getCheckpointRecentComments(history, projectId, checkpointId).filter((entry) => entry !== comment)]
    .slice(0, MAX_COMMENTS_PER_CHECKPOINT);
  const others = Object.entries(history)
    .filter(([entryKey]) => entryKey !== key)
    .slice(-(MAX_CHECKPOINT_HISTORIES - 1));
  return Object.fromEntries([...others, [key, recent]]);
}
