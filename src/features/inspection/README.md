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
review. They are not used to change checkpoint status or other inspection data automatically.
