"""Local GPU/CPU Voice Engine for MarketBrain Javis ("น้องตี๋").

Uses the exact same local models and voice cloning setup as d:/bctest01 (javis01):
- TTS: hotdogs/omnivoice-thai on CUDA fp16 cloned from ref_audio.wav (step=12, cfg=2.0, speed=1.0, RMS=0.16)
- STT (live partial captions + fallback): iapp/OpenThai2.0-ASR-Streaming-ONNX on CPU ONNX Runtime + Silero VAD
- STT (final transcript): typhoon-ai/typhoon-whisper-turbo (CTranslate2) on CUDA; falls back to OpenThai if it cannot load
"""
import asyncio
import gc
import io
import os
import re
import sys
import threading
import time
import unicodedata
import warnings
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor

import librosa
import numpy as np
import soundfile as sf
import torch
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from faster_whisper import WhisperModel
from faster_whisper.vad import VadOptions, get_speech_timestamps
from pythainlp.util import num_to_thaiword
from scipy.ndimage import maximum_filter1d, uniform_filter1d

warnings.filterwarnings("ignore", category=SyntaxWarning, module=r"f5_tts_th.*")
from f5_tts_th.normalize import normalize_text  # noqa: E402
from omnivoice import OmniVoice  # noqa: E402
from omnivoice.models.omnivoice import OmniVoiceGenerationConfig  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from openthai_asr import OpenThaiASR  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
REF_AUDIO_PATH = os.path.join(HERE, "ref_audio.wav")
REF_TEXT = "สวัสดีครับทุกคน วันนี้ผมมีอะไรน่าสนใจมาแนะนำเยอะมาก ตามมาดูกันเลยครับ"
TTS_MODEL_ID = os.environ.get("TTS_MODEL", "hotdogs/omnivoice-thai")
STT_MODEL_DIR = os.environ.get("STT_MODEL_DIR", r"d:\bctest01\models\openthai2_asr_fp32")
STT_FINAL_MODEL_DIR = os.environ.get(
    "STT_FINAL_MODEL_DIR", os.path.join(os.path.dirname(HERE), ".data", "models", "typhoon-whisper-turbo-ct2")
)
WHISPER_BEAM_SIZE = max(1, int(os.environ.get("STT_BEAM_SIZE", "3")))
WHISPER_INITIAL_PROMPT = os.environ.get(
    "STT_INITIAL_PROMPT",
    "ร้านค้าส่งปลีกไทย สว่านไฟฟ้า ข้องอ 4 หุน กระดาษชำระ น้ำมันพืช น้ำปลา ไม้จิ้มฟัน แชมพูขจัดรังแค คันหัว คันเท้า บรีสเอกเซล เครื่องปั่นไฟ",
)
TTS_SAMPLE_RATE = 24000
TTS_STEP = 12
TTS_CFG = 2.0
TTS_SPEED = 1.0
TTS_RMS = 0.16
PORT = int(os.environ.get("VOICE_PORT", "3091"))

GREET_TEXT = "สวัสดีครับ ผมน้องตี๋ เลขาช่วยหาสินค้าและรับออเดอร์ครับ อยากดูสินค้าตัวไหน พูดหรือพิมพ์บอกตี๋ได้เลยนะครับ"
PREWARM_PHRASES = (
    "สั่งตามเบอร์ได้เลยครับ",
    "ล้างตะกร้าให้แล้วครับ เลือกสินค้าใหม่ได้เลยครับ",
    "ตะกร้าว่างอยู่แล้วครับ",
    "รับเบอร์ไหนดีครับ",
    "รับอะไรเพิ่มหรือคิดเงินเลยครับ",
    "รับทราบครับ",
)

JUNK = re.compile(r"<think>.*?</think>|[*#_`~>|\[\]{}]|^\s*[-•]\s*|[\u3040-\u30ff\u4e00-\u9fff]", re.S | re.M)

_THAI_TERMS = (
    ("MarketBrain", "มาร์เก็ตเบรน"),
    ("PromptPay", "พร้อมเพย์"),
    ("COD", "เก็บเงินปลายทาง"),
    ("Halal", "ฮาลาล"),
    ("No MSG", "ไม่ใส่ผงชูรส"),
    ("MSG", "ผงชูรส"),
    ("GS1", "จีเอสวัน"),
    ("QR", "คิวอาร์"),
    ("SKU", "เอสเคยู"),
    ("VAT", "แวต"),
    ("LINE", "ไลน์"),
    ("Online", "ออนไลน์"),
    ("Javis", "จาวิส"),
    ("UHT", "ยูเอชที"),
    ("SPF", "เอสพีเอฟ"),
    ("PET", "เพ็ท"),
    ("BBQ", "บาร์บีคิว"),
    ("Clear Nose", "เคลียร์โนส"),
    ("Sunlight", "ซันไลต์"),
    ("Breeze", "บรีส"),
    ("Downy", "ดาวน์นี่"),
    ("Hygiene", "ไฮยีน"),
    ("Colgate", "คอลเกต"),
    ("Nescafe", "เนสกาแฟ"),
    ("Nestle", "เนสท์เล่"),
    ("Ovaltine", "โอวัลติน"),
    ("Milo", "ไมโล"),
    ("Coke", "โค้ก"),
    ("Pepsi", "เป๊ปซี่"),
    ("Lays", "เลย์"),
    ("Knorr", "คนอร์"),
    ("Maggi", "แม็กกี้"),
    ("Spam", "สแปม"),
    ("Supercat", "ซูเปอร์แคท"),
)
_TERM_RE = re.compile(r"(?i)(?<![A-Za-z0-9])(" + "|".join(re.escape(k) for k, _ in _THAI_TERMS) + r")(?![A-Za-z0-9])")
_TERM_MAP = {k.lower(): f" {v} " for k, v in _THAI_TERMS}
_LETTER_TH = dict(
    zip(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        (
            "เอ", "บี", "ซี", "ดี", "อี", "เอฟ", "จี", "เอช", "ไอ", "เจ", "เค", "แอล", "เอ็ม",
            "เอ็น", "โอ", "พี", "คิว", "อาร์", "เอส", "ที", "ยู", "วี", "ดับเบิลยู", "เอ็กซ์", "วาย", "แซด",
        ),
    )
)
_NUMBER_RE = re.compile(r"(?<!\d)(?<!\d\.)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?!\d|\.\d)(\s?%)?")


def _digits(digits: str) -> str:
    return "".join(num_to_thaiword(int(d)) for d in digits)


def _number_words(m: re.Match) -> str:
    whole = m.group(1).replace(",", "")
    frac = (m.group(2) or "").rstrip("0") and m.group(2)
    coded = "," not in m.group(1) and (len(whole) > 9 or (whole[0] == "0" and len(whole) > 2))
    words = _digits(whole) if coded else num_to_thaiword(int(whole))
    return f" {words}{'จุด' + _digits(frac) if frac else ''}{'เปอร์เซ็นต์' if m.group(3) else ''} "


def _say_numbers(text: str) -> str:
    out = str(text).replace("฿", " ")
    out = re.sub(
        r"(?<![\d.,-])0\d{1,2}(?:-\d{3,4}){1,2}(?![\d-])",
        lambda m: " " + " ".join(_digits(g) for g in m.group(0).split("-")) + " ",
        out,
    )
    out = re.sub(r"(?<![\d-])([1-9][\d,.]*) ?- ?([1-9][\d,.]*)(?![\d-])", r"\1 ถึง \2", out)
    return _NUMBER_RE.sub(_number_words, out)


def _thai_pronounce(text: str) -> str:
    cleaned = JUNK.sub(" ", str(text))
    out = _TERM_RE.sub(lambda m: _TERM_MAP[m.group(1).lower()], cleaned)
    out = re.sub(
        r"(?<![A-Za-z0-9])[A-Z]{2,5}(?![A-Za-z0-9])",
        lambda m: " " + "".join(_LETTER_TH[c] for c in m.group(0)) + " ",
        out,
    )
    return re.sub(r"\s+", " ", out).strip()


def level_audio(arr: np.ndarray) -> np.ndarray:
    rms = float(np.sqrt(np.mean(arr ** 2))) if arr.size else 0.0
    if rms < 1e-4:
        return arr
    arr = arr * (TTS_RMS / rms)
    win = 2 * int(0.02 * TTS_SAMPLE_RATE) + 1
    gain = np.minimum(1.0, 0.95 / np.maximum(maximum_filter1d(np.abs(arr), win), 1e-6))
    return (arr * uniform_filter1d(gain, win)).astype(np.float32)


print("[voice_service] Loading OpenThai 2.0 ASR Streaming (CPU ONNX)...", flush=True)
stt_engine = OpenThaiASR(STT_MODEL_DIR, lang="th-TH", intra_threads=8)

has_cuda = torch.cuda.is_available()
print(f"[voice_service] Loading OmniVoice ({TTS_MODEL_ID}) on {'cuda:0' if has_cuda else 'cpu'}...", flush=True)
kw = dict(device_map="cuda:0" if has_cuda else "cpu", dtype=torch.float16 if has_cuda else torch.float32)
try:
    tts_model = OmniVoice.from_pretrained(TTS_MODEL_ID, local_files_only=True, **kw)
except Exception:
    tts_model = OmniVoice.from_pretrained(TTS_MODEL_ID, **kw)

voice_prompt = tts_model.create_voice_clone_prompt(ref_audio=REF_AUDIO_PATH, ref_text=REF_TEXT)
tts_lock = threading.Lock()


def load_final_stt():
    """Typhoon Whisper Turbo on GPU for the final transcript; None -> OpenThai handles everything."""
    if not has_cuda or not os.path.isdir(STT_FINAL_MODEL_DIR):
        print("[voice_service] Final STT model/GPU not available; using OpenThai only", flush=True)
        return None
    # CTranslate2 needs cuBLAS/cuDNN DLLs; reuse the ones bundled with torch instead of installing anything.
    os.environ["PATH"] = os.path.join(os.path.dirname(torch.__file__), "lib") + os.pathsep + os.environ.get("PATH", "")
    try:
        print(f"[voice_service] Loading Typhoon Whisper Turbo (CUDA int8_float16, beam={WHISPER_BEAM_SIZE})...", flush=True)
        model = WhisperModel(STT_FINAL_MODEL_DIR, device="cuda", compute_type="int8_float16")
        list(model.transcribe(np.zeros(16000, dtype=np.float32), language="th", beam_size=WHISPER_BEAM_SIZE, initial_prompt=WHISPER_INITIAL_PROMPT or None)[0])  # warm-up
        return model
    except Exception as exc:
        print(f"[voice_service] Final STT load failed ({exc}); using OpenThai only", flush=True)
        return None


# Loaded after TTS so the voice keeps VRAM priority when the GPU is nearly full.
final_stt = load_final_stt()
final_stt_lock = threading.Lock()
stt_partial_lock = threading.Lock()
vad_lock = threading.Lock()
stt_executor = ThreadPoolExecutor(max_workers=2)


def _clean_whisper_hallucination(text: str) -> str:
    """Drop known Whisper silence artifacts and runaway token repetition loops (e.g. 'เล็บ เล็บ เล็บ...' x40)."""
    t = text.strip()
    if not t:
        return ""
    if t in {"เสียงดนตรี", "ดนตรี", "[เสียงดนตรี]", "ขอบคุณครับที่รับชม", "ขอบคุณค่ะที่รับชม"}:
        return ""
    # Space-separated word repetition loop (e.g. "เล็บ เล็บ เล็บ เล็บ เล็บ...")
    words = t.split()
    if len(words) >= 6:
        run = 1
        max_run = 1
        for i in range(1, len(words)):
            if words[i] == words[i - 1]:
                run += 1
                if run > max_run:
                    max_run = run
            else:
                run = 1
        if max_run >= 5:
            # Collapse runs >= 3; if most of the transcript was just the loop, drop the whole hallucination
            if max_run / len(words) >= 0.45:
                return ""
            dedup: list[str] = []
            for w in words:
                if len(dedup) >= 2 and dedup[-1] == w and dedup[-2] == w:
                    continue
                dedup.append(w)
            t = " ".join(dedup)
    # Contiguous Thai/Latin short syllable loop without spaces (e.g. "ตัวตัวตัวตัวตัวตัว")
    m_loop = re.search(r"([ก-๙A-Za-z]{1,6})\1{4,}", t)
    if m_loop:
        if len(m_loop.group(0)) / max(len(t), 1) >= 0.45:
            return ""
        t = re.sub(r"([ก-๙A-Za-z]{1,6})\1{3,}", r"\1", t).strip()
    return t


def _transcribe_whisper(pcm: np.ndarray) -> str:
    if final_stt is None:
        return ""
    try:
        with final_stt_lock:
            # Match bctest01 proven CUDA Whisper settings: NO repetition_penalty (penalizing repeated Thai vowels/consonants
            # in byte-level BPE corrupts Thai spelling), beam=3 + domain prompt, and 300ms VAD pad so soft stops stay intact.
            segments, _ = final_stt.transcribe(
                pcm,
                language="th",
                beam_size=WHISPER_BEAM_SIZE,
                initial_prompt=WHISPER_INITIAL_PROMPT or None,
                vad_filter=True,
                vad_parameters=dict(threshold=0.45, min_silence_duration_ms=400, speech_pad_ms=300),
                condition_on_previous_text=False,
                without_timestamps=True,
            )
            raw = "".join(seg.text for seg in segments).strip()
            return unicodedata.normalize("NFC", _clean_whisper_hallucination(raw))
    except Exception as exc:
        print(f"[voice_service] Final STT failed ({exc}); falling back to OpenThai", flush=True)
        return ""


def _transcribe_openthai(pcm: np.ndarray) -> str:
    try:
        with stt_partial_lock:
            raw = stt_engine.transcribe(pcm).strip()
        return unicodedata.normalize("NFC", _clean_whisper_hallucination(raw))
    except Exception as exc:
        print(f"[voice_service] OpenThai STT failed ({exc})", flush=True)
        return ""


def transcribe_dual(pcm: np.ndarray) -> dict:
    """Run GPU Typhoon-Whisper (Ear 1) concurrently with CPU OpenThai 2.0 (Ear 2)."""
    if final_stt is None:
        t0 = time.perf_counter()
        ear2 = _transcribe_openthai(pcm)
        ms2 = round((time.perf_counter() - t0) * 1000)
        return {"text": ear2, "altText": "", "ear1": "", "ear2": ear2, "ear1Ms": 0, "ear2Ms": ms2}

    def run_ear1() -> tuple[str, int]:
        t0 = time.perf_counter()
        return _transcribe_whisper(pcm), round((time.perf_counter() - t0) * 1000)

    def run_ear2() -> tuple[str, int]:
        t0 = time.perf_counter()
        return _transcribe_openthai(pcm), round((time.perf_counter() - t0) * 1000)

    fut1 = stt_executor.submit(run_ear1)
    fut2 = stt_executor.submit(run_ear2)
    ear1, ear1_ms = fut1.result()
    ear2, ear2_ms = fut2.result()
    primary = ear1 or ear2
    alt = ear2 if ear1 and ear2 and ear2 != ear1 else ""
    return {
        "text": primary,
        "altText": alt,
        "ear1": ear1,
        "ear2": ear2,
        "ear1Ms": ear1_ms,
        "ear2Ms": ear2_ms,
    }


def _trim_silence(arr: np.ndarray, top_db: float = 40.0) -> np.ndarray:
    """Fast vectorized RMS silence trim (<0.5 ms vs 30-60 ms librosa STFT trim)."""
    if arr.size < 256:
        return arr
    peak = float(np.max(np.abs(arr)))
    if peak < 1e-6:
        return arr
    thresh = peak * (10.0 ** (-top_db / 20.0))
    hop = 240  # 10 ms at 24 kHz
    n_frames = arr.size // hop
    if n_frames <= 1:
        return arr
    frames = arr[: n_frames * hop].reshape(n_frames, hop)
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    voiced = np.flatnonzero(rms > thresh)
    if voiced.size == 0:
        return arr
    pad_pre = int(0.03 * TTS_SAMPLE_RATE)
    pad_post = int(0.05 * TTS_SAMPLE_RATE)
    start = max(0, int(voiced[0]) * hop - pad_pre)
    end = min(arr.size, int(voiced[-1] + 1) * hop + pad_post)
    return arr[start:end]


audio_cache: "OrderedDict[str, tuple[bytes, float]]" = OrderedDict()


def synthesize_wav(text: str) -> tuple[bytes, float]:
    key = text.strip()
    if key in audio_cache:
        audio_cache.move_to_end(key)
        return audio_cache[key]

    norm = normalize_text(_thai_pronounce(_say_numbers(key))).strip()
    if not norm:
        silent = np.zeros(TTS_SAMPLE_RATE // 10, dtype=np.float32)
        buf = io.BytesIO()
        sf.write(buf, silent, TTS_SAMPLE_RATE, format="WAV", subtype="PCM_16")
        return buf.getvalue(), 0.1

    arr = np.zeros(0, dtype=np.float32)
    for _ in range(3):
        with tts_lock, torch.inference_mode():
            wav = tts_model.generate(
                text=norm,
                language="th",
                voice_clone_prompt=voice_prompt,
                speed=TTS_SPEED,
                generation_config=OmniVoiceGenerationConfig(num_step=TTS_STEP, guidance_scale=TTS_CFG),
            )[0]
        cand = np.asarray(wav, dtype=np.float32).reshape(-1) if wav is not None else np.zeros(0, dtype=np.float32)
        if cand.size:
            cand = _trim_silence(cand, top_db=40.0)
            if cand.size:
                arr = level_audio(cand)
                break

    if not arr.size:
        arr = np.zeros(TTS_SAMPLE_RATE // 10, dtype=np.float32)

    # 60ms silent pre-roll so browser/speaker wake-up never clips the first Thai syllable
    preroll = np.zeros(int(0.06 * TTS_SAMPLE_RATE), dtype=np.float32)
    full = np.concatenate([preroll, arr])
    dur = round(float(full.size) / TTS_SAMPLE_RATE, 3)

    buf = io.BytesIO()
    sf.write(buf, full, TTS_SAMPLE_RATE, format="WAV", subtype="PCM_16")
    wav_bytes = buf.getvalue()

    if len(audio_cache) >= 256:
        audio_cache.popitem(last=False)
    audio_cache[key] = (wav_bytes, dur)
    return wav_bytes, dur


print("[voice_service] Warming up greeting & hot phrases...", flush=True)
t_warm = time.perf_counter()
GREET_BYTES, GREET_DUR = synthesize_wav(GREET_TEXT)
for _phrase in PREWARM_PHRASES:
    synthesize_wav(_phrase)
gc.collect()
if has_cuda:
    torch.cuda.empty_cache()
print(
    f"[voice_service] Ready in {time.perf_counter() - t_warm:.2f}s "
    f"(greeting={GREET_DUR}s, cached={len(audio_cache)}, step={TTS_STEP}, speed={TTS_SPEED}) on 127.0.0.1:{PORT}",
    flush=True,
)

app = FastAPI()


@app.get("/health")
def health():
    return {
        "ok": True,
        "persona": "น้องตี๋",
        "ttsModel": TTS_MODEL_ID,
        "device": "cuda:0" if has_cuda else "cpu",
        "sttModel": "typhoon-whisper-turbo" if final_stt is not None else "OpenThai2.0-ASR-Streaming-ONNX",
        "sttPartialModel": "OpenThai2.0-ASR-Streaming-ONNX",
        "sttDualEar": final_stt is not None,
        "sttBeamSize": WHISPER_BEAM_SIZE,
        "greetText": GREET_TEXT,
        "greetDur": GREET_DUR,
    }


def _clean_gpu_mem() -> dict:
    gc.collect()
    info: dict = {"ok": True, "cuda": has_cuda}
    if has_cuda:
        torch.cuda.empty_cache()
        if hasattr(torch.cuda, "ipc_collect"):
            torch.cuda.ipc_collect()
        info["allocatedMb"] = round(torch.cuda.memory_allocated(0) / (1024 * 1024), 1)
        info["reservedMb"] = round(torch.cuda.memory_reserved(0) / (1024 * 1024), 1)
    return info


@app.post("/gc")
async def gc_endpoint():
    return await asyncio.to_thread(_clean_gpu_mem)


@app.get("/greet.wav")
def greet_wav():
    return Response(
        content=GREET_BYTES,
        media_type="audio/wav",
        headers={
            "X-Audio-Duration": str(GREET_DUR),
            "Cache-Control": "no-store",
        },
    )


@app.post("/tts")
async def tts_endpoint(req: Request):
    body = await req.json()
    text = str(body.get("text", "")).strip()[:600]
    if not text:
        return JSONResponse({"error": "empty text"}, status_code=400)
    t0 = time.perf_counter()
    wav_bytes, dur = await asyncio.to_thread(synthesize_wav, text)
    gen_ms = round((time.perf_counter() - t0) * 1000)
    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={
            "X-Audio-Duration": str(dur),
            "X-Gen-Ms": str(gen_ms),
            "Cache-Control": "no-store",
        },
    )


def _process_stt(raw: bytes, sr_header: int, fmt: str, is_partial: bool) -> dict:
    if fmt == "f32le":
        pcm = np.frombuffer(raw, dtype=np.float32).copy()
        if sr_header != 16000 and pcm.size > 0:
            pcm = librosa.resample(pcm, orig_sr=sr_header, target_sr=16000)
    else:
        pcm, _ = librosa.load(io.BytesIO(raw), sr=16000, mono=True)

    if pcm.size < 1600:
        return {"text": "", "voiced": False}
    # Cap any runaway utterance to the last 15 seconds so STT latency never explodes on ambient noise.
    if pcm.size > 16000 * 15:
        pcm = pcm[-16000 * 15 :]

    if is_partial:
        # Guard partial captions with gentle Silero VAD (200ms pad keeps first Thai syllable intact).
        vad_opts = VadOptions(threshold=0.45, min_speech_duration_ms=150, min_silence_duration_ms=300, speech_pad_ms=200)
        with vad_lock:
            spans = get_speech_timestamps(pcm, vad_opts)
        if not spans:
            return {"text": "", "voiced": False}
        voiced_pcm = np.concatenate([pcm[s["start"] : s["end"]] for s in spans])
        if not stt_partial_lock.acquire(blocking=False):
            return {"text": "", "voiced": False, "skipped": True}
        try:
            text = stt_engine.transcribe(voiced_pcm).strip()
        finally:
            stt_partial_lock.release()
    else:
        # Dual-Ear final STT: run GPU Typhoon-Whisper (Ear 1) in parallel with CPU OpenThai 2.0 (Ear 2).
        dual = transcribe_dual(pcm)
        return {
            **dual,
            "voiced": bool(dual["text"] or dual["ear2"]),
        }
    text = unicodedata.normalize("NFC", _clean_whisper_hallucination(text))
    return {"text": text, "voiced": bool(text)}


@app.post("/stt")
async def stt_endpoint(req: Request):
    raw = await req.body()
    if not raw or len(raw) < 640:
        return {"text": "", "voiced": False}
    if await req.is_disconnected():
        return {"text": "", "voiced": False}

    sr_header = int(req.headers.get("x-sample-rate", "16000") or "16000")
    fmt = req.headers.get("x-audio-format", "f32le")
    is_partial = req.headers.get("x-partial", "0") == "1"
    # Live partial captions are disposable — never let them queue up behind an active partial or starve final STT.
    if is_partial and stt_partial_lock.locked():
        return {"text": "", "voiced": False, "skipped": True}
    return await asyncio.to_thread(_process_stt, raw, sr_header, fmt, is_partial)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
