import { isCheckpointReviewed, type Area, type Checkpoint, type Item, type Location } from '@/types';

export type CheckpointNavigationEntry = {
  location: Location;
  item: Item;
  checkpoint: Checkpoint;
};

export function getNextPendingCheckpoint(
  area: Area,
  currentCheckpointId: string | null,
  options: { excludedLocationNames?: Iterable<string> } = {}
): CheckpointNavigationEntry | null {
  const excludedNames = new Set(
    [...(options.excludedLocationNames ?? [])].map((name) => name.trim().toLowerCase())
  );
  const entries = area.locations
    .filter((location) => !excludedNames.has(location.name.trim().toLowerCase()))
    .flatMap((location) =>
      location.items.flatMap((item) =>
        item.checkpoints.map((checkpoint) => ({ location, item, checkpoint }))
      )
    );

  const currentIndex = currentCheckpointId
    ? entries.findIndex((entry) => entry.checkpoint.id === currentCheckpointId)
    : -1;
  const orderedEntries = currentIndex >= 0
    ? [...entries.slice(currentIndex + 1), ...entries.slice(0, currentIndex + 1)]
    : entries;

  return orderedEntries.find((entry) => !isCheckpointReviewed(entry.checkpoint)) ?? null;
}
