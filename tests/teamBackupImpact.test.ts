import { describe, expect, it } from 'vitest';
import { createArea, createCheckpoint, createItem, createLocation, createProject } from '@/lib/db';
import { formatTeamBackupImpact, summarizeTeamBackupImpact } from '@/features/projects/teamBackupImpact';

describe('team backup impact preview', () => {
  it('identifies local-only areas, restored areas, and changed checkpoints before a restore', () => {
    const device = createProject('Tower', 'Current address');
    const lobby = createArea(device.id, 'Lobby', 0);
    const room = createLocation(lobby.id, 'Entry', 0);
    const item = createItem(room.id, 'Door', 0);
    const checkpoint = createCheckpoint(item.id, 'Finish', 0);
    checkpoint.status = 'needsReview';
    item.checkpoints.push(checkpoint);
    room.items.push(item);
    lobby.locations.push(room);
    device.areas.push(lobby, createArea(device.id, 'Device only', 1));

    const backup = structuredClone(device);
    backup.address = 'Earlier address';
    backup.areas = [backup.areas[0], createArea(device.id, 'Backup only', 1)];
    backup.areas[0].locations[0].items[0].checkpoints[0].status = 'ok';

    const impact = summarizeTeamBackupImpact(device, backup);
    expect(impact.deviceOnlyAreas).toEqual(['Device only']);
    expect(impact.backupOnlyAreas).toEqual(['Backup only']);
    expect(impact.changedAreas).toEqual(['Lobby']);
    expect(impact.changedCheckpoints).toBe(1);
    expect(impact.projectDetailsChanged).toBe(true);
    expect(formatTeamBackupImpact(impact).join(' ')).toContain('Device only');
    expect(formatTeamBackupImpact(impact).join(' ')).toContain('Project details or settings differ');
  });
});
