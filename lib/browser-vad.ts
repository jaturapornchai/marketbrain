// Client-side Silero VAD v5 runner powered by self-hosted ONNX Runtime WASM (/vad/*).
// Runs single-threaded WASM (no SharedArrayBuffer / COOP-COEP needed) with ~0.5 ms per 32 ms frame.
// Gracefully returns null on older browsers / iOS versions lacking WASM SIMD so Tier-A fallback works seamlessly.

const MODEL_URL = "/vad/silero_vad_v5.onnx";
const WASM_BASE = "/vad/";
const CONTEXT_SAMPLES = 64;
const STATE_LEN = 2 * 128;

type OrtModule = typeof import("onnxruntime-web/wasm");

let cachedModelBuf: Promise<ArrayBuffer> | null = null;
let cachedOrt: Promise<OrtModule> | null = null;

async function loadOrt(): Promise<OrtModule> {
  if (!cachedOrt) {
    cachedOrt = import("onnxruntime-web/wasm").then((ort) => {
      ort.env.wasm.wasmPaths = WASM_BASE;
      ort.env.wasm.numThreads = 1;
      ort.env.logLevel = "error";
      return ort;
    });
  }
  return cachedOrt;
}

async function fetchModelBuffer(): Promise<ArrayBuffer> {
  if (!cachedModelBuf) {
    cachedModelBuf = fetch(MODEL_URL).then((res) => {
      if (!res.ok) throw new Error(`Silero VAD model HTTP ${res.status}`);
      return res.arrayBuffer();
    });
  }
  return cachedModelBuf;
}

export class BrowserSileroVad {
  private readonly ort: OrtModule;
  private readonly session: import("onnxruntime-web/wasm").InferenceSession;
  private readonly srTensor: import("onnxruntime-web/wasm").Tensor;
  private stateTensor: import("onnxruntime-web/wasm").Tensor;
  private context = new Float32Array(CONTEXT_SAMPLES);
  private busy = false;
  private released = false;
  private lastProb = 0;

  private constructor(
    ort: OrtModule,
    session: import("onnxruntime-web/wasm").InferenceSession,
  ) {
    this.ort = ort;
    this.session = session;
    this.srTensor = new ort.Tensor("int64", BigInt64Array.from([16000n]));
    this.stateTensor = new ort.Tensor("float32", new Float32Array(STATE_LEN), [2, 1, 128]);
  }

  static async create(): Promise<BrowserSileroVad | null> {
    if (typeof window === "undefined" || typeof WebAssembly === "undefined") return null;
    try {
      const [ort, buf] = await Promise.all([loadOrt(), fetchModelBuffer()]);
      // Copy buffer slice so cached ArrayBuffer stays reusable across mic re-attachments.
      const session = await ort.InferenceSession.create(new Uint8Array(buf.slice(0)), {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      return new BrowserSileroVad(ort, session);
    } catch {
      return null;
    }
  }

  /** Resets RNN hidden state & 64-sample context window between turns or playback switches. */
  reset(): void {
    if (this.released) return;
    this.context.fill(0);
    this.lastProb = 0;
    try {
      this.stateTensor.dispose();
    } catch {
      // ignore
    }
    this.stateTensor = new this.ort.Tensor("float32", new Float32Array(STATE_LEN), [2, 1, 128]);
  }

  /**
   * Evaluates one 512-sample (32 ms @ 16 kHz) frame and returns speech probability (0..1).
   * If a previous inference is still running, returns the most recent probability without queuing backlog.
   */
  async process(frame512: Float32Array): Promise<number> {
    if (this.released) return 0;
    if (this.busy) return this.lastProb;
    this.busy = true;
    try {
      const withContext = new Float32Array(CONTEXT_SAMPLES + frame512.length);
      withContext.set(this.context, 0);
      withContext.set(frame512, CONTEXT_SAMPLES);
      this.context.set(frame512.subarray(Math.max(0, frame512.length - CONTEXT_SAMPLES)));

      const inputTensor = new this.ort.Tensor("float32", withContext, [1, withContext.length]);
      const out = await this.session.run({
        input: inputTensor,
        state: this.stateTensor,
        sr: this.srTensor,
      });
      inputTensor.dispose();

      const nextState = out.stateN;
      if (nextState) {
        try {
          this.stateTensor.dispose();
        } catch {
          // ignore
        }
        this.stateTensor = nextState;
      }
      const prob = Number(out.output?.data?.[0] ?? 0);
      if (out.output) {
        try {
          out.output.dispose();
        } catch {
          // ignore
        }
      }
      this.lastProb = Number.isFinite(prob) ? prob : 0;
      return this.lastProb;
    } catch {
      return this.lastProb;
    } finally {
      this.busy = false;
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      this.stateTensor.dispose();
      this.srTensor.dispose();
      await this.session.release();
    } catch {
      // ignore
    }
  }
}
