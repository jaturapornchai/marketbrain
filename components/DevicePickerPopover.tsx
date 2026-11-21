"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useJavis } from "./JavisContext";

type DeviceOption = {
  deviceId: string;
  label: string;
};

type SinkableAudio = HTMLAudioElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

export default function DevicePickerPopover({
  activeMicStream,
  onOpenCameraScanner,
  onSelectPhotoFile,
  buttonClassName = "jc-ctrl-pill",
  iconOnly = false,
}: {
  activeMicStream?: MediaStream | null;
  onOpenCameraScanner?: () => void;
  onSelectPhotoFile?: (file: File) => void;
  buttonClassName?: string;
  iconOnly?: boolean;
}) {
  const {
    micDeviceId,
    speakerDeviceId,
    cameraDeviceId,
    setMicDeviceId,
    setSpeakerDeviceId,
    setCameraDeviceId,
  } = useJavis();

  const [open, setOpen] = useState(false);
  const [mics, setMics] = useState<DeviceOption[]>([]);
  const [speakers, setSpeakers] = useState<DeviceOption[]>([]);
  const [cameras, setCameras] = useState<DeviceOption[]>([]);
  const [canSelectSpeaker, setCanSelectSpeaker] = useState(true);
  const [micLevel, setMicLevel] = useState(0);
  const [devNotice, setDevNotice] = useState("");
  const [testingSpk, setTestingSpk] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const testStreamRef = useRef<MediaStream | null>(null);
  const meterCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (typeof HTMLMediaElement !== "undefined") {
      setCanSelectSpeaker("setSinkId" in HTMLMediaElement.prototype);
    }
  }, []);

  const refreshDevices = useCallback(async (askPermissions = false) => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
      setDevNotice("เบราว์เซอร์นี้ไม่รองรับการเลือกอุปกรณ์เสียง/กล้อง");
      return;
    }
    try {
      if (askPermissions) {
        const tempAudio = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
        tempAudio?.getTracks().forEach((t) => t.stop());
        const tempVideo = await navigator.mediaDevices.getUserMedia({ video: true }).catch(() => null);
        tempVideo?.getTracks().forEach((t) => t.stop());
      }
      const list = await navigator.mediaDevices.enumerateDevices();
      const micList: DeviceOption[] = [];
      const spkList: DeviceOption[] = [];
      const camList: DeviceOption[] = [];

      list.forEach((d) => {
        if (!d.deviceId || d.deviceId === "default") return;
        if (d.kind === "audioinput") {
          micList.push({ deviceId: d.deviceId, label: d.label || `ไมโครโฟน ${micList.length + 1}` });
        } else if (d.kind === "audiooutput") {
          spkList.push({ deviceId: d.deviceId, label: d.label || `ลำโพง/หูฟัง ${spkList.length + 1}` });
        } else if (d.kind === "videoinput") {
          camList.push({ deviceId: d.deviceId, label: d.label || `กล้อง ${camList.length + 1}` });
        }
      });

      setMics(micList);
      setSpeakers(spkList);
      setCameras(camList);
      setDevNotice("");
    } catch {
      setDevNotice("ไม่สามารถอ่านรายชื่ออุปกรณ์ได้ กรุณาอนุญาตไมค์และกล้อง");
    }
  }, []);

  useEffect(() => {
    void refreshDevices(false);
    const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!media?.addEventListener) return;
    const handler = () => void refreshDevices(false);
    media.addEventListener("devicechange", handler);
    return () => media.removeEventListener("devicechange", handler);
  }, [refreshDevices]);

  // Close popover on outside click or Escape
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Live microphone level meter while popover is open (uses active call mic stream or opens a temporary one)
  useEffect(() => {
    const cleanupMeter = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      if (testStreamRef.current) {
        testStreamRef.current.getTracks().forEach((t) => t.stop());
        testStreamRef.current = null;
      }
      if (meterCtxRef.current) {
        void meterCtxRef.current.close().catch(() => {});
        meterCtxRef.current = null;
      }
      setMicLevel(0);
    };

    if (!open) {
      cleanupMeter();
      return;
    }

    let cancelled = false;
    (async () => {
      await refreshDevices(false);
      let sourceStream = activeMicStream ?? null;
      if (!sourceStream && navigator.mediaDevices?.getUserMedia) {
        try {
          sourceStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
              ...(micDeviceId ? { deviceId: { exact: micDeviceId } } : {}),
            },
          });
          if (cancelled) {
            sourceStream.getTracks().forEach((t) => t.stop());
            return;
          }
          testStreamRef.current = sourceStream;
          await refreshDevices(false);
        } catch {
          // mic may not be available in headless/PC without mic
          return;
        }
      }
      if (!sourceStream || cancelled) return;

      try {
        const ctx = new AudioContext();
        meterCtxRef.current = ctx;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        ctx.createMediaStreamSource(sourceStream).connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        const tick = () => {
          if (cancelled) return;
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buf.length);
          setMicLevel(Math.min(100, Math.round(rms * 480)));
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        // ignore audio context error
      }
    })();

    return cleanupMeter;
  }, [open, activeMicStream, micDeviceId, refreshDevices]);

  const handleTestSpeaker = async () => {
    if (testingSpk) return;
    setTestingSpk(true);
    setDevNotice("");
    try {
      const ctx = new AudioContext();
      await ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const dest = ctx.createMediaStreamDestination();
      const t = ctx.currentTime;
      [523.25, 659.25, 783.99].forEach((freq, idx) => {
        osc.frequency.setValueAtTime(freq, t + idx * 0.16);
      });
      gain.gain.setValueAtTime(0.26, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.78);
      osc.connect(gain).connect(dest);

      const audio = new Audio() as SinkableAudio;
      audio.srcObject = dest.stream;
      if (canSelectSpeaker && audio.setSinkId && speakerDeviceId) {
        await audio.setSinkId(speakerDeviceId);
      }
      await audio.play();
      osc.start(t);
      osc.stop(t + 0.8);
      osc.onended = () => {
        audio.srcObject = null;
        void ctx.close().catch(() => {});
        setTestingSpk(false);
      };
      setDevNotice("กำลังเล่นเสียงทดสอบออกลำโพงที่เลือกครับ ✓");
    } catch {
      setDevNotice("เล่นเสียงทดสอบไม่สำเร็จ กรุณาตรวจสอบลำโพง");
      setTestingSpk(false);
    }
  };

  return (
    <div className="dev-pop-wrap" ref={rootRef}>
      <button
        type="button"
        className={`${buttonClassName}${open ? " active" : ""}`}
        aria-expanded={open}
        aria-label="ตั้งค่าอุปกรณ์ ไมค์ ลำโพง และกล้องส่องสินค้า"
        title="ตั้งค่าอุปกรณ์ (ไมค์ · ลำโพง · กล้อง)"
        onClick={() => setOpen((v) => !v)}
      >
        {iconOnly ? <span aria-hidden="true">⚙️</span> : "⚙️ อุปกรณ์"}
      </button>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f && onSelectPhotoFile) {
            setOpen(false);
            onSelectPhotoFile(f);
          }
        }}
      />

      {open && (
        <div className="dev-popover" role="dialog" aria-label="เลือกไมค์ ลำโพง และกล้อง">
          <div className="dev-pop-head">
            <strong>⚙️ เลือกอุปกรณ์ (ไมค์ · ลำโพง · กล้อง)</strong>
            <div className="dev-head-acts">
              <button
                type="button"
                className="dev-refresh-btn"
                onClick={() => void refreshDevices(true)}
                title="ขอสิทธิ์และสแกนหาไมค์/ลำโพง/กล้องใหม่"
              >
                ↻ สแกนใหม่
              </button>
              <button type="button" className="jm-close-btn" onClick={() => setOpen(false)} aria-label="ปิด">
                ✕
              </button>
            </div>
          </div>

          {/* 1. Microphone Selector + Live Meter */}
          <div className="dev-field">
            <label htmlFor="mb-mic-select">🎙️ ไมโครโฟน (ลองพูด แถบสีเขียวต้องขยับ)</label>
            <select
              id="mb-mic-select"
              value={mics.some((m) => m.deviceId === micDeviceId) ? micDeviceId : ""}
              onChange={(e) => setMicDeviceId(e.target.value)}
            >
              <option value="">ค่าเริ่มต้นของระบบ (Default Mic)</option>
              {mics.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label}
                </option>
              ))}
            </select>
            <div className="dev-meter-track" aria-label="ระดับเสียงไมโครโฟน">
              <div className="dev-meter-bar" style={{ width: `${micLevel}%` }} />
            </div>
          </div>

          {/* 2. Speaker Selector + Chime Test */}
          <div className="dev-field">
            <label htmlFor="mb-spk-select">🔊 ลำโพง / หูฟังเสียงน้องตี๋</label>
            <div className="dev-inline-row">
              <select
                id="mb-spk-select"
                disabled={!canSelectSpeaker}
                value={speakers.some((s) => s.deviceId === speakerDeviceId) ? speakerDeviceId : ""}
                onChange={(e) => setSpeakerDeviceId(e.target.value)}
              >
                <option value="">
                  {canSelectSpeaker ? "ค่าเริ่มต้นของระบบ (Default Speaker)" : "ลำโพงของระบบ"}
                </option>
                {speakers.map((s) => (
                  <option key={s.deviceId} value={s.deviceId}>
                    {s.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn dev-test-btn"
                disabled={testingSpk}
                onClick={() => void handleTestSpeaker()}
              >
                🔊 ทดสอบเสียง
              </button>
            </div>
          </div>

          {/* 3. Camera Selector + Instant Visual Product Search */}
          <div className="dev-field">
            <label htmlFor="mb-cam-select">📷 กล้องส่องรูปสินค้า (เจอสินค้าค้นหาทันที)</label>
            <select
              id="mb-cam-select"
              value={cameras.some((c) => c.deviceId === cameraDeviceId) ? cameraDeviceId : ""}
              onChange={(e) => setCameraDeviceId(e.target.value)}
            >
              <option value="">กล้องอัตโนมัติ (กล้องหลังมือถือ / เว็บแคมหลัก)</option>
              {cameras.map((c) => (
                <option key={c.deviceId} value={c.deviceId}>
                  {c.label}
                </option>
              ))}
            </select>

            <div className="dev-cam-actions">
              {onOpenCameraScanner && (
                <button
                  type="button"
                  className="btn primary dev-cam-go"
                  onClick={() => {
                    setOpen(false);
                    onOpenCameraScanner();
                  }}
                >
                  📷 เปิดกล้องส่องสินค้าเลย
                </button>
              )}
              {onSelectPhotoFile && (
                <button
                  type="button"
                  className="btn dev-photo-go"
                  onClick={() => fileInputRef.current?.click()}
                >
                  🖼️ เลือกรูปสินค้าไปหาเลย
                </button>
              )}
            </div>
          </div>

          {devNotice && <p className="dev-notice">{devNotice}</p>}
        </div>
      )}
    </div>
  );
}
