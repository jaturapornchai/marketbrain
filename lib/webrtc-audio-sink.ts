// Local WebRTC Loopback AEC3 + Smooth GainNode Ducking Sink for Nong Tee TTS.
// - On Chromium/Firefox: routes AudioContext -> GainNode -> MediaStreamAudioDestinationNode -> local RTCPeerConnection
//   -> <audio> so Chrome's WebRTC AEC3 + Neural Residual Echo Estimator receives the exact speaker reference signal
//   (AND supports setSinkId custom speaker selection).
// - On iOS Safari/iPadOS: uses GainNode -> AudioContext.destination directly (paired with iOS VoiceProcessingIO
//   hardware AEC and navigator.audioSession = "play-and-record") so single-tap unlock & speaker routing stay rock-solid.

export type SinkableAudioEl = HTMLAudioElement & {
  setSinkId?: (deviceId: string) => Promise<void>;
};

export function isIOSWebKit(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/i.test(ua) || (/\bMacintosh\b/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
}

function configureIOSAudioSession(): void {
  try {
    const nav = navigator as Navigator & { audioSession?: { type: string } };
    if (nav.audioSession && nav.audioSession.type !== "play-and-record") {
      nav.audioSession.type = "play-and-record";
    }
  } catch {
    // Safari < 17 or restricted environment
  }
}

export class WebRtcAudioSink {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private destNode: MediaStreamAudioDestinationNode | null = null;
  private pc1: RTCPeerConnection | null = null;
  private pc2: RTCPeerConnection | null = null;
  private audioEl: SinkableAudioEl | null = null;
  private activeSource: AudioBufferSourceNode | null = null;
  private activeStartCtxTime: number | null = null;
  private connectedDirect = false;
  private loopbackReady = false;
  private loopbackConnecting: Promise<boolean> | null = null;
  private ducked = false;
  private sinkDeviceId = "";

  get isLoopbackActive(): boolean {
    return this.loopbackReady;
  }

  get contextState(): AudioContextState | "none" {
    return this.ctx ? this.ctx.state : "none";
  }

  attachElement(el: SinkableAudioEl | null): void {
    this.audioEl = el;
    if (el && this.sinkDeviceId && el.setSinkId) {
      void el.setSinkId(this.sinkDeviceId).catch(() => {});
    }
  }

  async setSinkId(deviceId: string): Promise<void> {
    this.sinkDeviceId = deviceId;
    if (this.audioEl?.setSinkId) {
      await this.audioEl.setSinkId(deviceId).catch(() => {});
    }
  }

  /** Must be called inside a user gesture at least once on mobile/desktop to unlock audio permanently. */
  unlock(): void {
    if (typeof window === "undefined") return;
    if (isIOSWebKit()) configureIOSAudioSession();

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    if (!this.ctx || this.ctx.state === "closed") {
      // Let the OS pick its native hardware sample rate (critical for iOS Safari stability).
      this.ctx = new AudioCtx();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 1;
      this.connectedDirect = false;
      this.loopbackReady = false;
    }

    if (this.ctx.state === "suspended") {
      void this.ctx.resume().catch(() => {});
    }

    // Play a 1-sample silent buffer inside the gesture so Web Audio unlocks across iOS Safari & Chrome.
    try {
      const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      const s = this.ctx.createBufferSource();
      s.buffer = b;
      s.connect(this.ctx.destination);
      s.start(0);
    } catch {
      // ignore
    }

    // If loopback is already wired to <audio>, ensure <audio> is playing inside the same gesture.
    if (this.loopbackReady && this.audioEl && this.audioEl.paused) {
      void this.audioEl.play().catch(() => {});
    }
  }

  private connectDirect(): void {
    if (!this.ctx || !this.gain) return;
    if (this.destNode) {
      try {
        this.gain.disconnect(this.destNode);
      } catch {
        // ignore
      }
    }
    if (!this.connectedDirect) {
      this.gain.connect(this.ctx.destination);
      this.connectedDirect = true;
    }
    this.loopbackReady = false;
  }

  private teardownLoopback(): void {
    this.loopbackReady = false;
    if (this.gain && this.destNode) {
      try {
        this.gain.disconnect(this.destNode);
      } catch {
        // ignore
      }
    }
    if (this.pc1) {
      try {
        this.pc1.close();
      } catch {
        // ignore
      }
      this.pc1 = null;
    }
    if (this.pc2) {
      try {
        this.pc2.close();
      } catch {
        // ignore
      }
      this.pc2 = null;
    }
    this.destNode = null;
    if (this.audioEl && this.audioEl.srcObject) {
      this.audioEl.srcObject = null;
    }
  }

  private async ensureLoopback(): Promise<boolean> {
    if (this.loopbackReady && this.audioEl && !this.audioEl.paused) return true;
    if (this.loopbackReady && this.audioEl) {
      try {
        await this.audioEl.play();
        return true;
      } catch {
        return false;
      }
    }
    if (this.loopbackConnecting) return this.loopbackConnecting;

    if (
      isIOSWebKit() ||
      !this.ctx ||
      !this.gain ||
      !this.audioEl ||
      typeof RTCPeerConnection === "undefined" ||
      typeof this.ctx.createMediaStreamDestination !== "function"
    ) {
      return false;
    }

    const audioEl = this.audioEl;
    const ctx = this.ctx;
    const gain = this.gain;

    this.loopbackConnecting = (async () => {
      try {
        this.teardownLoopback();
        const dest = ctx.createMediaStreamDestination();
        const track = dest.stream.getAudioTracks()[0];
        if (!track) return false;

        const pc1 = new RTCPeerConnection();
        const pc2 = new RTCPeerConnection();
        this.destNode = dest;
        this.pc1 = pc1;
        this.pc2 = pc2;

        pc1.onicecandidate = (e) => {
          if (e.candidate) void pc2.addIceCandidate(e.candidate).catch(() => {});
        };
        pc2.onicecandidate = (e) => {
          if (e.candidate) void pc1.addIceCandidate(e.candidate).catch(() => {});
        };

        const trackReady = new Promise<MediaStream>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("LOOPBACK_TIMEOUT")), 1200);
          pc2.ontrack = (ev) => {
            clearTimeout(timer);
            resolve(ev.streams[0] || new MediaStream([ev.track]));
          };
        });

        pc1.addTrack(track, dest.stream);
        const offer = await pc1.createOffer({ offerToReceiveAudio: true });
        await pc1.setLocalDescription(offer);
        await pc2.setRemoteDescription(offer);
        const answer = await pc2.createAnswer();
        await pc2.setLocalDescription(answer);
        await pc1.setRemoteDescription(answer);

        const remoteStream = await trackReady;
        audioEl.pause();
        audioEl.removeAttribute("src");
        audioEl.volume = 1;
        audioEl.muted = false;
        audioEl.srcObject = remoteStream;
        if (this.sinkDeviceId && audioEl.setSinkId) {
          await audioEl.setSinkId(this.sinkDeviceId).catch(() => {});
        }
        await audioEl.play();

        if (this.connectedDirect) {
          try {
            gain.disconnect(ctx.destination);
          } catch {
            // ignore
          }
          this.connectedDirect = false;
        }
        gain.connect(dest);
        this.loopbackReady = true;
        return true;
      } catch {
        this.teardownLoopback();
        return false;
      } finally {
        this.loopbackConnecting = null;
      }
    })();

    return this.loopbackConnecting;
  }

  /** Smoothly ducks TTS output to 15% during Stage-1 barge-in, or restores to 100%. */
  setDuck(ducked: boolean): void {
    if (this.ducked === ducked) return;
    this.ducked = ducked;
    if (this.ctx && this.gain) {
      const target = ducked ? 0.15 : 1.0;
      const now = this.ctx.currentTime;
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setTargetAtTime(target, now, 0.022);
    }
    // Only adjust <audio>.volume when playing a non-loopback direct src file.
    if (this.audioEl && !this.loopbackReady) {
      this.audioEl.volume = ducked ? 0.15 : 1.0;
    }
  }

  /** Returns current playback offset in seconds for EchoGuard's envelope comparison. */
  currentTimeSec(): number | null {
    if (this.ctx && this.activeSource && this.activeStartCtxTime !== null) {
      return Math.max(0, this.ctx.currentTime - this.activeStartCtxTime);
    }
    return null;
  }

  /**
   * Plays a WAV ArrayBuffer through WebRTC loopback AEC3 (or direct Web Audio on iOS/fallback).
   * Returns true if playback started, or false if the context is still locked waiting for user gesture.
   */
  async playBuffer(
    buf: ArrayBuffer,
    onEnded: () => void,
    isStillCurrent: () => boolean,
  ): Promise<boolean> {
    if (!this.ctx || !this.gain) this.unlock();
    if (!this.ctx || !this.gain) return false;
    if (this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch {
        return false;
      }
    }
    if (this.ctx.state !== "running") return false;

    if (isIOSWebKit()) {
      configureIOSAudioSession();
      this.connectDirect();
    } else {
      const ok = await this.ensureLoopback();
      if (!ok) {
        // If user selected a non-default speaker and loopback failed, let caller fall back to HTMLAudioElement.
        if (this.sinkDeviceId) return false;
        this.connectDirect();
      }
    }

    if (!isStillCurrent()) return true;

    try {
      const decoded = await this.ctx.decodeAudioData(buf.slice(0));
      if (!isStillCurrent()) return true;

      this.stopActive();
      this.setDuck(false);
      const src = this.ctx.createBufferSource();
      src.buffer = decoded;
      src.connect(this.gain);
      this.activeSource = src;
      this.activeStartCtxTime = this.ctx.currentTime;
      src.onended = () => {
        if (this.activeSource === src) {
          this.activeSource = null;
          this.activeStartCtxTime = null;
        }
        onEnded();
      };
      src.start(0);
      return true;
    } catch {
      return false;
    }
  }

  stopActive(): void {
    if (this.activeSource) {
      try {
        this.activeSource.onended = null;
        this.activeSource.stop();
        this.activeSource.disconnect();
      } catch {
        // already stopped
      }
      this.activeSource = null;
    }
    this.activeStartCtxTime = null;
    this.setDuck(false);
  }

  dispose(): void {
    this.stopActive();
    this.teardownLoopback();
    if (this.ctx && this.ctx.state !== "closed") {
      void this.ctx.close().catch(() => {});
    }
    this.ctx = null;
    this.gain = null;
    this.connectedDirect = false;
  }
}
