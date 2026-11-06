# Inspection

Checkpoint comments keep their typing state inside the text field, so keystrokes
do not rerender the photo gallery or inspection list. Every input is written to
the recovery journal immediately. The heavier project/team-queue save waits for
600 ms of idle typing; blur and closing the active checkpoint commit immediately.

Checkpoint voice notes use `OfflineVoiceNoteButton` and a dedicated browser worker to run a small
Whisper model on the device. Microphone samples are captured as raw PCM, mixed and resampled to
mono 16 kHz locally, and never uploaded to an application API. The model is downloaded on first use
and reused from the browser cache.

Voice transcripts are inserted into the active checkpoint comment and returned to the textarea for
review. Saving a new non-empty checkpoint note (typed or transcribed), or adding a new photo,
automatically marks an unflagged checkpoint as an open issue. Existing open, resolved, and verified
issues keep their state. Blank or unchanged notes, photo-save retries, and removing evidence do not
change the issue state. The evidence, issue state, and pending team sync are saved together.
