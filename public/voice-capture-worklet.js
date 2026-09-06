class InspectionVoiceCapture extends AudioWorkletProcessor {
  constructor() { super(); this.samples = []; this.active = true; this.port.onmessage = ({ data }) => { if (data === 'stop') { this.flush(); this.active = false; this.port.postMessage({ stopped: true }); } }; }
  flush() { if (this.samples.length) { const audio = new Float32Array(this.samples); this.samples = []; this.port.postMessage({ audio }, [audio.buffer]); } }
  process(inputs) {
    const channels = inputs[0];
    if (this.active && channels?.length) {
      for (let i = 0; i < channels[0].length; i++) { let sample = 0; for (const channel of channels) sample += channel[i] / channels.length; this.samples.push(sample); }
      if (this.samples.length >= sampleRate) this.flush();
    }
    return this.active;
  }
}
registerProcessor('inspection-voice-capture', InspectionVoiceCapture);
