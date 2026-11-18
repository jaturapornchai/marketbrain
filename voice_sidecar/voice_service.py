"""Local GPU/CPU Voice Engine for MarketBrain Javis ("น้องตี๋").

Uses the exact same local models and voice cloning setup as d:/bctest01 (javis01):
- TTS: hotdogs/omnivoice-thai on CUDA fp16 cloned from ref_audio.wav (step=16, cfg=2.0, speed=0.9, RMS=0.16)
- STT: iapp/OpenThai2.0-ASR-Streaming-ONNX on CPU ONNX Runtime + Silero VAD
"""
import io
import os
import re
import sys
import threading
import time
import warnings
from collections import OrderedDict

import librosa
import numpy as np
import soundfile as sf
import torch
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
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
TTS_SAMPLE_RATE = 24000
TTS_STEP = 16
TTS_CFG = 2.0
TTS_SPEED = 0.9
TTS_RMS = 0.16
PORT = int(os.environ.get("VOICE_PORT", "3091"))

GREET_TEXT = "สวัสดีครับ ผมน้องตี๋ เลขาช่วยหาสินค้าและรับออเดอร์ครับ อยากดูสินค้าตัวไหน พูดหรือพิมพ์บอกตี๋ได้เลยนะครับ"

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
        with tts_lock:
            wav = tts_model.generate(
                text=norm,
                language="th",
                voice_clone_prompt=voice_prompt,
                speed=TTS_SPEED,
                generation_config=OmniVoiceGenerationConfig(num_step=TTS_STEP, guidance_scale=TTS_CFG),
            )[0]
        cand = np.asarray(wav, dtype=np.float32).reshape(-1) if wav is not None else np.zeros(0, dtype=np.float32)
        if cand.size:
            _, idx = librosa.effects.trim(cand, top_db=40)
            if idx[1] > idx[0]:
                pad_pre = int(0.03 * TTS_SAMPLE_RATE)
                pad_post = int(0.05 * TTS_SAMPLE_RATE)
                cand = cand[max(0, int(idx[0]) - pad_pre) : min(cand.size, int(idx[1]) + pad_post)]
            if cand.size:
                arr = level_audio(cand)
                break

    if not arr.size:
        arr = np.zeros(TTS_SAMPLE_RATE // 10, dtype=np.float32)

    # 40ms silent pre-roll so browser audio output never clips the first syllable
    preroll = np.zeros(int(0.04 * TTS_SAMPLE_RATE), dtype=np.float32)
    full = np.concatenate([preroll, arr])
    dur = round(float(full.size) / TTS_SAMPLE_RATE, 3)

    buf = io.BytesIO()
    sf.write(buf, full, TTS_SAMPLE_RATE, format="WAV", subtype="PCM_16")
    wav_bytes = buf.getvalue()

    if len(audio_cache) >= 48:
        audio_cache.popitem(last=False)
    audio_cache[key] = (wav_bytes, dur)
    return wav_bytes, dur


print("[voice_service] Warming up greeting voice...", flush=True)
t_warm = time.perf_counter()
GREET_BYTES, GREET_DUR = synthesize_wav(GREET_TEXT)
print(f"[voice_service] Ready in {time.perf_counter() - t_warm:.2f}s (greeting={GREET_DUR}s) on 127.0.0.1:{PORT}", flush=True)

app = FastAPI()


@app.get("/health")
def health():
    return {
        "ok": True,
        "persona": "น้องตี๋",
        "ttsModel": TTS_MODEL_ID,
        "device": "cuda:0" if has_cuda else "cpu",
        "sttModel": "OpenThai2.0-ASR-Streaming-ONNX",
        "greetText": GREET_TEXT,
        "greetDur": GREET_DUR,
    }


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
    wav_bytes, dur = synthesize_wav(text)
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


@app.post("/stt")
async def stt_endpoint(req: Request):
    raw = await req.body()
    if not raw or len(raw) < 640:
        return {"text": "", "voiced": False}

    sr_header = int(req.headers.get("x-sample-rate", "16000") or "16000")
    fmt = req.headers.get("x-audio-format", "f32le")

    if fmt == "f32le":
        pcm = np.frombuffer(raw, dtype=np.float32).copy()
        if sr_header != 16000 and pcm.size > 0:
            pcm = librosa.resample(pcm, orig_sr=sr_header, target_sr=16000)
    else:
        pcm, _ = librosa.load(io.BytesIO(raw), sr=16000, mono=True)

    if pcm.size < 1600:
        return {"text": "", "voiced": False}

    # Check Silero VAD unless partial streaming flag is set
    is_partial = req.headers.get("x-partial", "0") == "1"
    if not is_partial:
        spans = get_speech_timestamps(pcm, VadOptions(min_silence_duration_ms=350, speech_pad_ms=40))
        if not spans:
            return {"text": "", "voiced": False}
        voiced_pcm = np.concatenate([pcm[s["start"] : s["end"]] for s in spans])
    else:
        voiced_pcm = pcm

    text = stt_engine.transcribe(voiced_pcm).strip()
    if text == "เสียงดนตรี":
        text = ""
    return {"text": text, "voiced": bool(text)}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
