# Inspection

Checkpoint voice notes use `OfflineVoiceNoteButton` and a dedicated browser worker to run a small
Whisper model on the device. Audio is decoded to mono 16 kHz samples locally and is never uploaded
to an application API. The model is downloaded on first use and reused from the browser cache.

Voice transcripts are inserted into the active checkpoint comment and returned to the textarea for
review. They are not used to change checkpoint status or other inspection data automatically.
