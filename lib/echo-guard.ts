// Speaker-echo guard for the live mic loop (client-safe, no DOM/Node imports).
// Idea: we know exactly what Nong Tee is playing, so compare the mic level against the level
// of the sound being played right now. Echo follows the played level; a customer does not.

const ENVELOPE_HOP_SEC = 0.064;
const UNKNOWN_PLAYED_RMS = 0.25; // envelope not decoded yet -> assume he is at full voice
const ECHO_WINDOW_SEC = 0.6; // one mic frame (256 ms) + speaker/mic latency
const PLAYED_AUDIBLE_RMS = 0.02;
const CALIB_FRAMES = 3; // loud frames used to learn how strongly the speaker leaks into the mic
const BARGE_MIN_RMS = 0.03; // customer must be at least this loud
const BARGE_OVER_ECHO = 2; // ...and this many times louder than the expected echo
export const BARGE_FRAMES = 2; // ...for this many mic frames in a row (~0.5 s)

/** RMS envelope (one value per 64 ms) of a PCM16 mono/stereo WAV, or null if the file is not PCM16. */
export function wavEnvelope(buf: ArrayBuffer): Float32Array | null {
  const view = new DataView(buf);
  if (buf.byteLength < 44 || view.getUint32(0, false) !== 0x52494646) return null; // "RIFF"
  let pos = 12;
  let channels = 1;
  let rate = 24000;
  let pcm16 = false;
  while (pos + 8 <= buf.byteLength) {
    const id = view.getUint32(pos, false);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 0x666d7420) {
      // "fmt "
      pcm16 = view.getUint16(body, true) === 1 && view.getUint16(body + 14, true) === 16;
      channels = view.getUint16(body + 2, true) || 1;
      rate = view.getUint32(body + 4, true) || rate;
    } else if (id === 0x64617461) {
      // "data"
      if (!pcm16) return null;
      const frames = Math.floor(Math.min(size, buf.byteLength - body) / (2 * channels));
      const hop = Math.max(1, Math.round(rate * ENVELOPE_HOP_SEC));
      const env = new Float32Array(Math.ceil(frames / hop));
      for (let h = 0; h < env.length; h++) {
        const end = Math.min(frames, (h + 1) * hop);
        let sumSq = 0;
        for (let i = h * hop; i < end; i++) {
          const v = view.getInt16(body + i * 2 * channels, true) / 32768;
          sumSq += v * v;
        }
        env[h] = Math.sqrt(sumSq / Math.max(1, end - h * hop));
      }
      return env;
    }
    pos = body + size + (size & 1);
  }
  return null;
}

/** Loudest level played during the window that can still be in the mic frame ending at `currentTimeSec`. */
export function playedLevel(env: Float32Array | null, currentTimeSec: number): number {
  if (!env) return UNKNOWN_PLAYED_RMS;
  const last = Math.min(env.length - 1, Math.floor(currentTimeSec / ENVELOPE_HOP_SEC));
  const first = Math.max(0, Math.floor((currentTimeSec - ECHO_WINDOW_SEC) / ENVELOPE_HOP_SEC));
  let max = 0;
  for (let i = first; i <= last; i++) if (env[i] > max) max = env[i];
  return max;
}

export class EchoGuard {
  /** Learned ratio mic level / played level when only the echo is present. Kept for the whole call. */
  private gain = 0;
  private calibrated = 0;
  private run = 0;

  /**
   * Feed one mic frame heard while Nong Tee is talking.
   * Returns how many frames in a row sounded like the customer (0 = echo/silence);
   * the customer has barged in once it reaches BARGE_FRAMES.
   */
  hear(micRms: number, playedRms: number): number {
    if (playedRms >= PLAYED_AUDIBLE_RMS) {
      const ratio = micRms / playedRms;
      if (this.calibrated < CALIB_FRAMES) {
        this.calibrated++;
        this.gain = Math.max(this.gain, ratio);
        return (this.run = 0);
      }
      const isCustomer = micRms > Math.max(BARGE_MIN_RMS, this.gain * playedRms * BARGE_OVER_ECHO);
      // Follow the echo down quickly-ish, up only slowly, so a customer talking over him cannot raise the bar.
      this.gain = ratio < this.gain ? this.gain * 0.9 + ratio * 0.1 : Math.min(ratio, this.gain * 1.03);
      if (!isCustomer) return (this.run = 0);
    } else if (micRms <= BARGE_MIN_RMS) {
      return (this.run = 0);
    }
    return ++this.run;
  }

  resetRun(): void {
    this.run = 0;
  }
}
