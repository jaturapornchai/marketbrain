// High-precision, zero-GC mic capture worklet:
// Downsamples any hardware AudioContext rate (48k/44.1k/16k) to 16 kHz mono
// and emits exact 512-sample (32 ms) frames for Silero VAD v5 + EchoGuard.

const TARGET_SR = 16000;
const FRAME_SAMPLES = 512;

class MbMicCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ratio = sampleRate / TARGET_SR;
    this._inBuf = new Float32Array(0);
    this._inPos = 0;
    this._outFrame = new Float32Array(FRAME_SAMPLES);
    this._outIdx = 0;
  }

  _appendInput(channel) {
    const remaining = this._inBuf.length - Math.floor(this._inPos);
    const start = Math.floor(this._inPos);
    const next = new Float32Array(Math.max(0, remaining) + channel.length);
    if (remaining > 0) {
      next.set(this._inBuf.subarray(start), 0);
    }
    next.set(channel, Math.max(0, remaining));
    this._inBuf = next;
    this._inPos -= start;
  }

  _emitFrame() {
    const frame = this._outFrame;
    let sumSq = 0;
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      const v = frame[i];
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / FRAME_SAMPLES);
    this.port.postMessage({ frame, rms }, [frame.buffer]);
    this._outFrame = new Float32Array(FRAME_SAMPLES);
    this._outIdx = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;
    const ch = input[0];

    // Fast path: native 16 kHz hardware/context
    if (Math.abs(this._ratio - 1) < 1e-4) {
      for (let i = 0; i < ch.length; i++) {
        this._outFrame[this._outIdx++] = ch[i];
        if (this._outIdx === FRAME_SAMPLES) this._emitFrame();
      }
      return true;
    }

    // Box-averaged / linear downsampler for 48 kHz, 44.1 kHz, etc. (reduces aliasing)
    this._appendInput(ch);
    const ratio = this._ratio;
    const buf = this._inBuf;
    const len = buf.length;

    while (this._inPos + ratio < len) {
      const start = this._inPos;
      const end = start + ratio;
      const i0 = Math.floor(start);
      const i1 = Math.min(len - 1, Math.floor(end));
      let acc = 0;
      let wSum = 0;
      for (let i = i0; i <= i1; i++) {
        const segStart = Math.max(start, i);
        const segEnd = Math.min(end, i + 1);
        const w = Math.max(0, segEnd - segStart);
        acc += buf[i] * w;
        wSum += w;
      }
      this._outFrame[this._outIdx++] = wSum > 0 ? acc / wSum : buf[i0];
      this._inPos = end;
      if (this._outIdx === FRAME_SAMPLES) this._emitFrame();
    }

    return true;
  }
}

registerProcessor("mb-mic-capture", MbMicCaptureProcessor);
