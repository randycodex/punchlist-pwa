'use client';

import PhotoCapture from '@/components/PhotoCapture';
import type { Area } from '@/types';
import { getCheckpointIssueState } from '@/types';

const ignoreMutation = () => {};

/** A locked area remains inspectable without mounting any editing controls. */
export default function ReadOnlyArea({ area }: { area: Area }) {
  return (
    <div className="list-stack mx-auto w-full max-w-6xl">
      <p className="text-sm text-gray-500 dark:text-gray-300">Read-only · Saved on this device. Other devices’ unsynced changes are not shown.</p>
      {area.locations.map((location) => (
        <details key={location.id} className="inspection-location-surface rounded-[1.7rem] p-4">
          <summary className="cursor-pointer font-semibold">{location.name}</summary>
          <div className="mt-3 space-y-3">
            {location.items.map((item) => (
              <details key={item.id} className="rounded-xl p-3 soft-control">
                <summary className="cursor-pointer font-medium">{item.name}</summary>
                {item.checkpoints.map((checkpoint) => (
                  <section key={checkpoint.id} className="mt-3 space-y-2 border-t border-gray-300/30 pt-3">
                    <p className="font-medium">{checkpoint.name}</p>
                    <p className="text-sm text-gray-500 dark:text-gray-300">{getCheckpointIssueState(checkpoint) !== 'none' ? `Issue — ${getCheckpointIssueState(checkpoint)}` : checkpoint.status === 'ok' ? 'OK' : 'Not inspected'}</p>
                    {checkpoint.comments && <p className="whitespace-pre-wrap">{checkpoint.comments}</p>}
                    <PhotoCapture readOnly photos={checkpoint.photos} files={checkpoint.files ?? []} onAddPhoto={ignoreMutation} onDeletePhoto={ignoreMutation} onDeleteFile={ignoreMutation} />
                  </section>
                ))}
              </details>
            ))}
          </div>
        </details>
      ))}
      {area.notes && <section className="inspection-location-surface rounded-[1.7rem] p-4"><h2 className="font-semibold">Area notes</h2><p className="mt-2 whitespace-pre-wrap">{area.notes}</p></section>}
    </div>
  );
}
