"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { JavisProductCard, VisionDetectedProduct } from "@/lib/product-card";
import { useJavis } from "./JavisContext";

export type VisionLookupResult = {
  ok: boolean;
  hasProduct: boolean;
  exactMatch: boolean;
  matchedQuery: string;
  detected: VisionDetectedProduct;
  cards: JavisProductCard[];
  totalMatches: number;
  snapshotDataUrl: string;
  ms: number;
  error?: string;
};

type BrowserBarcodeDetector = {
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>>;
};

export async function resizeImageToDataUrl(source: Blob | File, maxDim = 720): Promise<string> {
  const bitmapUrl = URL.createObjectURL(source);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("ไม่สามารถอ่านไฟล์รูปภาพได้"));
      el.src = bitmapUrl;
    });
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const w = Math.max(1, Math.round((img.naturalWidth || 640) * scale));
    const h = Math.max(1, Math.round((img.naturalHeight || 480) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas ไม่พร้อมใช้งาน");
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.84);
  } finally {
    URL.revokeObjectURL(bitmapUrl);
  }
}

export async function identifyProductFromFile(file: File | Blob): Promise<VisionLookupResult> {
  const snapshotDataUrl = await resizeImageToDataUrl(file, 720);
  let barcodeHint = "";
  if (typeof window !== "undefined" && "BarcodeDetector" in window) {
    try {
      const img = await createImageBitmap(file);
      const DetectorCtor = (window as unknown as { BarcodeDetector: new (opts?: { formats?: string[] }) => BrowserBarcodeDetector })
        .BarcodeDetector;
      const detector = new DetectorCtor({
        formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"],
      });
      const codes = await detector.detect(img);
      barcodeHint = codes.find((c) => c.rawValue && c.rawValue.length >= 8)?.rawValue ?? "";
      img.close();
    } catch {
      // ignore if BarcodeDetector doesn't support format
    }
  }

  const res = await fetch("/api/vision/identify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageBase64: snapshotDataUrl, barcodeHint }),
  });
  const json = (await res.json()) as Omit<VisionLookupResult, "snapshotDataUrl">;
  return {
    ...json,
    snapshotDataUrl,
  };
}

export default function ProductVisionScanner({
  onProductFound,
  onClose,
}: {
  onProductFound: (result: VisionLookupResult) => void;
  onClose?: () => void;
}) {
  const { cameraDeviceId, setCameraDeviceId } = useJavis();
  const [cameras, setCameras] = useState<Array<{ deviceId: string; label: string }>>([]);
  const [autoScan, setAutoScan] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState("");
  // Floating price tag over the live video for a moment before the stage switches to the product.
  const [priceTag, setPriceTag] = useState<{ title: string; price: string; exact: boolean } | null>(null);
  const tagTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (tagTimerRef.current) clearTimeout(tagTimerRef.current);
  }, []);
  const [scanHint, setScanHint] = useState("ถือสินค้าหรือบาร์โค้ดส่องหน้ากล้อง ระบบจะค้นหาสินค้าให้อัตโนมัติทันทีครับ");

  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const inFlightRef = useRef(false);
  const prevLumaRef = useRef<Float32Array | null>(null);
  const lastMatchedKeyRef = useRef<{ key: string; at: number }>({ key: "", at: 0 });
  const onProductFoundRef = useRef(onProductFound);
  onProductFoundRef.current = onProductFound;

  const refreshCameraList = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const cams = devs
        .filter((d) => d.kind === "videoinput" && d.deviceId)
        .map((d, idx) => ({
          deviceId: d.deviceId,
          label: d.label || `กล้อง ${idx + 1}`,
        }));
      setCameras(cams);
    } catch {
      // ignore
    }
  }, []);

  // Start live camera stream using selected cameraDeviceId
  useEffect(() => {
    let cancelled = false;

    const stopStream = () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      setCameraReady(false);
    };

    (async () => {
      stopStream();
      setCameraError("");
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError("เบราว์เซอร์นี้ไม่รองรับการเปิดกล้องสด แต่สามารถกดเลือกรูปสินค้าหรือวางรูป (Ctrl+V) เพื่อค้นหาได้ทันทีครับ");
        return;
      }

      try {
        const videoConstraints: MediaTrackConstraints = cameraDeviceId
          ? { deviceId: { exact: cameraDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
          : { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } };

        const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setCameraReady(true);
        await refreshCameraList();
      } catch {
        // Fallback to any camera if exact deviceId failed
        try {
          const fallbackStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          if (cancelled) {
            fallbackStream.getTracks().forEach((t) => t.stop());
            return;
          }
          streamRef.current = fallbackStream;
          if (videoRef.current) {
            videoRef.current.srcObject = fallbackStream;
            await videoRef.current.play().catch(() => {});
          }
          setCameraReady(true);
          await refreshCameraList();
        } catch {
          setCameraError("ยังเปิดกล้องไม่ได้ (อาจไม่มีกล้องหรือยังไม่อนุญาตสิทธิ์) กดปุ่ม 'เลือกรูปสินค้า' ด้านล่างเพื่อค้นหาจากรูปได้ทันทีครับ");
        }
      }
    })();

    return () => {
      cancelled = true;
      stopStream();
    };
  }, [cameraDeviceId, refreshCameraList]);

  const captureVideoFrame = useCallback(
    (maxDim = 600): { dataUrl: string; changedEnough: boolean } | null => {
      const vid = videoRef.current;
      if (!vid || vid.readyState < 2 || !vid.videoWidth || !vid.videoHeight) return null;

      // Compute 16x16 luma grid to detect blank frames or completely unchanged static background
      const tiny = document.createElement("canvas");
      tiny.width = 16;
      tiny.height = 16;
      const tCtx = tiny.getContext("2d");
      let changedEnough = true;
      if (tCtx) {
        tCtx.drawImage(vid, 0, 0, 16, 16);
        const px = tCtx.getImageData(0, 0, 16, 16).data;
        const luma = new Float32Array(256);
        let sum = 0;
        for (let i = 0; i < 256; i++) {
          const y = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
          luma[i] = y;
          sum += y;
        }
        const mean = sum / 256;
        let variance = 0;
        for (let i = 0; i < 256; i++) variance += (luma[i] - mean) ** 2;
        variance /= 256;

        // Skip pitch-black or completely flat solid color frames
        if (variance < 35) {
          return { dataUrl: "", changedEnough: false };
        }

        if (prevLumaRef.current) {
          let diff = 0;
          for (let i = 0; i < 256; i++) diff += Math.abs(luma[i] - prevLumaRef.current[i]);
          diff /= 256;
          if (diff < 5.5) {
            changedEnough = false;
          }
        }
        if (changedEnough) prevLumaRef.current = luma;
      }

      const scale = Math.min(1, maxDim / Math.max(vid.videoWidth, vid.videoHeight));
      const w = Math.max(1, Math.round(vid.videoWidth * scale));
      const h = Math.max(1, Math.round(vid.videoHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(vid, 0, 0, w, h);
      return { dataUrl: canvas.toDataURL("image/jpeg", 0.82), changedEnough };
    },
    [],
  );

  const analyzeFrame = useCallback(
    async (opts: { manual?: boolean; barcodeHint?: string }) => {
      if (inFlightRef.current) return;
      const frame = captureVideoFrame(opts.manual ? 768 : 580);
      if (!frame) return;
      if (!opts.manual && !opts.barcodeHint && !frame.changedEnough) return;
      if (!frame.dataUrl && !opts.barcodeHint) return;

      inFlightRef.current = true;
      setScanning(true);
      setScanHint(
        opts.barcodeHint
          ? `อ่านบาร์โค้ด ${opts.barcodeHint} ได้แล้ว กำลังดึงสินค้าทันที…`
          : "กำลังวิเคราะห์รูปสินค้าด้วย Local Vision AI…",
      );

      try {
        const res = await fetch("/api/vision/identify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            imageBase64: frame.dataUrl,
            barcodeHint: opts.barcodeHint || "",
          }),
        });
        const json = (await res.json()) as Omit<VisionLookupResult, "snapshotDataUrl">;

        if (json.ok && json.hasProduct && (json.cards.length > 0 || opts.manual)) {
          const dedupKey = json.cards[0]?.slug || json.matchedQuery;
          const now = Date.now();
          if (!opts.manual && dedupKey && lastMatchedKeyRef.current.key === dedupKey && now - lastMatchedKeyRef.current.at < 9000) {
            setScanHint(`เจอสินค้า "${json.cards[0]?.title || json.matchedQuery}" แล้วครับ`);
            return;
          }
          lastMatchedKeyRef.current = { key: dedupKey, at: now };
          setScanHint(`✅ เจอสินค้า "${json.cards[0]?.title || json.detected.summaryTh}" แล้ว! กำลังเปิดแสดงทันที…`);
          const found = { ...json, snapshotDataUrl: frame.dataUrl };
          const top = json.cards[0];
          if (top) {
            setPriceTag({ title: top.title, price: top.priceLabel, exact: json.exactMatch });
            if (tagTimerRef.current) clearTimeout(tagTimerRef.current);
            tagTimerRef.current = setTimeout(() => onProductFoundRef.current(found), 1400);
          } else onProductFoundRef.current(found);
        } else if (opts.manual) {
          setScanHint("ยังไม่เห็นตัวสินค้าหรือฉลากชัดเจน ลองขยับสินค้าเข้ามาใกล้กล้องอีกนิดแล้วกดถ่ายใหม่นะครับ");
        } else {
          setScanHint("กำลังมองหาสินค้าหน้ากล้อง… (ส่องฉลากหรือบาร์โค้ดเข้ามาได้เลยครับ)");
        }
      } catch {
        setScanHint("เชื่อมต่อ Vision AI ขัดข้องชั่วคราว ลองกดถ่ายอีกครั้งครับ");
      } finally {
        inFlightRef.current = false;
        setScanning(false);
      }
    },
    [captureVideoFrame],
  );

  // Fast Hardware/Browser BarcodeDetector loop (~350ms) + Periodic Auto Vision AI loop (~2300ms)
  useEffect(() => {
    if (!cameraReady || !autoScan) return;

    let barcodeTimer: ReturnType<typeof setInterval> | null = null;
    if (typeof window !== "undefined" && "BarcodeDetector" in window) {
      try {
        const DetectorCtor = (window as unknown as { BarcodeDetector: new (opts?: { formats?: string[] }) => BrowserBarcodeDetector })
          .BarcodeDetector;
        const detector = new DetectorCtor({
          formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128"],
        });
        barcodeTimer = setInterval(async () => {
          if (inFlightRef.current || !videoRef.current || videoRef.current.readyState < 2) return;
          try {
            const found = await detector.detect(videoRef.current);
            const code = found.find((b) => b.rawValue && b.rawValue.length >= 8)?.rawValue;
            if (code) {
              void analyzeFrame({ barcodeHint: code });
            }
          } catch {
            // ignore frame detect error
          }
        }, 380);
      } catch {
        // BarcodeDetector unavailable
      }
    }

    const visionTimer = setInterval(() => {
      if (!inFlightRef.current) {
        void analyzeFrame({ manual: false });
      }
    }, 2300);

    return () => {
      if (barcodeTimer) clearInterval(barcodeTimer);
      clearInterval(visionTimer);
    };
  }, [cameraReady, autoScan, analyzeFrame]);

  const handleFileUpload = async (file: File) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setScanning(true);
    setScanHint(`กำลังอ่านรูปสินค้า "${file.name}" เพื่อค้นหาในสมองทันที…`);
    try {
      const result = await identifyProductFromFile(file);
      if (result.ok && (result.cards.length > 0 || result.hasProduct)) {
        onProductFoundRef.current(result);
      } else {
        setScanHint(result.error || "ไม่พบสินค้าที่ตรงในรูปภาพนี้ ลองใช้รูปที่เห็นฉลากหรือชื่อสินค้าชัดขึ้นนะครับ");
      }
    } catch {
      setScanHint("ไม่สามารถอ่านไฟล์รูปภาพได้");
    } finally {
      inFlightRef.current = false;
      setScanning(false);
    }
  };

  return (
    <div className="vscan-box">
      <div className="vscan-head">
        <div>
          <h3>📷 กล้องส่องสินค้า & ค้นหาด้วยรูปอัตโนมัติ</h3>
          <p className="muted">{scanHint}</p>
        </div>
        <div className="vscan-head-right">
          <select
            className="vscan-cam-sel"
            value={cameras.some((c) => c.deviceId === cameraDeviceId) ? cameraDeviceId : ""}
            onChange={(e) => setCameraDeviceId(e.target.value)}
            aria-label="เลือกกล้องส่องสินค้า"
          >
            <option value="">กล้องอัตโนมัติ</option>
            {cameras.map((c) => (
              <option key={c.deviceId} value={c.deviceId}>
                {c.label}
              </option>
            ))}
          </select>
          {onClose && (
            <button type="button" className="btn" onClick={onClose}>
              ✕ ปิดกล้อง
            </button>
          )}
        </div>
      </div>

      <div className="vscan-stage">
        {cameraError ? (
          <div className="vscan-fallback">
            <p>{cameraError}</p>
            <button type="button" className="btn primary" onClick={() => fileInputRef.current?.click()}>
              🖼️ เลือกรูปสินค้าจากเครื่อง / มือถือเพื่อค้นหาทันที
            </button>
          </div>
        ) : (
          <div className="vscan-video-wrap">
            <video ref={videoRef} autoPlay playsInline muted className="vscan-video" />
            <div className={`vscan-reticle${scanning ? " active" : ""}`} aria-hidden="true">
              <span className="vc tl" />
              <span className="vc tr" />
              <span className="vc bl" />
              <span className="vc br" />
            </div>
            {scanning && <div className="vscan-badge">🔍 กำลังค้นหาสินค้าในสมอง…</div>}
            {priceTag && (
              <div className="fz-cam-tag" role="status">
                <small>{priceTag.exact ? "✅ เจอตรงรุ่น" : "🔎 ใกล้เคียงที่สุด"}</small>
                <b>{priceTag.price}</b>
                <span>{priceTag.title}</span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="vscan-controls">
        <button
          type="button"
          className="btn primary vscan-shutter-btn"
          disabled={!cameraReady || scanning}
          onClick={() => void analyzeFrame({ manual: true })}
        >
          📸 ถ่ายภาพค้นสินค้าทันที
        </button>

        <button
          type="button"
          className="btn"
          disabled={scanning}
          onClick={() => fileInputRef.current?.click()}
        >
          🖼️ เลือกรูปสินค้าไปหาเลย
        </button>

        <label className="vscan-auto-toggle">
          <input
            type="checkbox"
            checked={autoScan}
            onChange={(e) => setAutoScan(e.target.checked)}
          />
          <span>👁️ เจอสินค้าแล้วค้นหาเลยอัตโนมัติ</span>
        </label>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void handleFileUpload(f);
        }}
      />
    </div>
  );
}
