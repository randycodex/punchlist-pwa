# Inspection

Checkpoint comments keep their typing state inside the text field, so keystrokes
do not rerender the photo gallery or inspection list. Every input is written to
the recovery journal immediately. The heavier project/team-queue save waits for
600 ms of idle typing; blur and closing the active checkpoint commit immediately.

Saving a new non-empty checkpoint note, or adding a new photo,
automatically marks an unflagged checkpoint as an open issue. Existing open, resolved, and verified
issues keep their state. Blank or unchanged notes, photo-save retries, and removing evidence do not
change the issue state. The evidence, issue state, and pending team sync are saved together.

Recording and transcription have been removed. Read compatibility preserves interrupted captures
from older releases: saved transcript text can be restored as a note without a model download.
Older captures without saved text remain on the device and continue to protect the project from
automatic deletion. App updates do not purge browser data or previously downloaded caches.
