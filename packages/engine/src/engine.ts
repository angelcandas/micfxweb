// Loads engine.wasm (the desktop MicFX DSP compiled to WebAssembly) and wraps its C API.
//
// Runs anywhere WebAssembly does: the AudioWorklet (the app), Node (the tests). It uses no
// TextEncoder/TextDecoder because AudioWorkletGlobalScope doesn't have them in every
// browser; the IDs crossing the boundary are ASCII.

export interface ValueInfo {
  id: string;
  defaultValue: number;
  isSwitch: boolean;
}

export interface Meters {
  /** Peak since the last read, after the input gain (linear). */
  input: number;
  /** Peak since the last read, after the limiter (linear). */
  output: number;
  /** Samples of delay the effects add (autotune, pitch shift). */
  latencySamples: number;
}

interface Exports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  micfx_text(): number;
  micfx_create(sampleRate: number, maxBlockSize: number): number;
  micfx_destroy(engine: number): void;
  micfx_input(engine: number): number;
  micfx_output(engine: number, channel: number): number;
  micfx_process(engine: number, frames: number): void;
  micfx_set_value(engine: number, idLength: number, value: number): number;
  micfx_get_value(engine: number, idLength: number): number;
  micfx_reset_values(engine: number): void;
  micfx_value_info(engine: number): number;
  micfx_set_order(engine: number, length: number): void;
  micfx_get_order(engine: number): number;
  micfx_meters(engine: number): number;
}

const TEXT_SIZE = 32768;
const ENOSYS = 52;

// The WASI and Emscripten imports the standalone wasm declares. The DSP never reads files
// or the environment, so these only have to exist; the clock is the one that answers.
function makeImports(memory: () => WebAssembly.Memory): WebAssembly.Imports {
  const now = () => (globalThis.performance?.now?.() ?? Date.now()) * 1e6;
  const fail = () => ENOSYS;
  return {
    env: {
      emscripten_notify_memory_growth: () => {},
      __syscall_faccessat: () => -ENOSYS,
    },
    wasi_snapshot_preview1: {
      clock_time_get: (_id: number, _precision: bigint, out: number) => {
        new DataView(memory().buffer).setBigUint64(out, BigInt(Math.floor(now())), true);
        return 0;
      },
      environ_sizes_get: (count: number, size: number) => {
        const view = new DataView(memory().buffer);
        view.setUint32(count, 0, true);
        view.setUint32(size, 0, true);
        return 0;
      },
      environ_get: () => 0,
      fd_close: fail,
      fd_seek: fail,
      fd_read: fail,
      fd_write: (_fd: number, iovs: number, count: number, written: number) => {
        // Discard (JUCE's DBG output), but report it written so nothing retries.
        const view = new DataView(memory().buffer);
        let total = 0;
        for (let i = 0; i < count; ++i) total += view.getUint32(iovs + i * 8 + 4, true);
        view.setUint32(written, total, true);
        return 0;
      },
    },
  };
}

/** Instantiates the wasm module synchronously (allowed in an AudioWorklet for a compiled Module). */
export function instantiateEngineModule(module: WebAssembly.Module): EngineRuntime {
  let exports: Exports | undefined;
  const instance = new WebAssembly.Instance(module, makeImports(() => exports!.memory));
  exports = instance.exports as unknown as Exports;
  exports._initialize();
  return new EngineRuntime(exports);
}

/** The loaded wasm: makes engines. One per AudioWorklet is plenty. */
export class EngineRuntime {
  constructor(private readonly exports: Exports) {}

  create(sampleRate: number, maxBlockSize = 128): LiveEngine {
    return new LiveEngine(this.exports, sampleRate, maxBlockSize);
  }
}

/** MicFX Live mode's voice path: mic -> input gain -> effects -> output gain -> limiter. */
export class LiveEngine {
  private handle: number;
  readonly maxBlockSize: number;

  constructor(private readonly x: Exports, sampleRate: number, maxBlockSize: number) {
    this.maxBlockSize = maxBlockSize;
    this.handle = x.micfx_create(sampleRate, maxBlockSize);
  }

  /** The engine's mono input buffer. Re-read after any call that may grow memory. */
  input(): Float32Array {
    return new Float32Array(this.x.memory.buffer, this.x.micfx_input(this.handle), this.maxBlockSize);
  }

  output(channel: 0 | 1): Float32Array {
    return new Float32Array(this.x.memory.buffer, this.x.micfx_output(this.handle, channel), this.maxBlockSize);
  }

  /** Processes `frames` samples from input() into output(0) and output(1). */
  process(frames: number): void {
    this.x.micfx_process(this.handle, frames);
  }

  /** Copies `mic` in, processes it, and copies the result out. */
  render(mic: Float32Array, left: Float32Array, right: Float32Array): void {
    const frames = Math.min(mic.length, this.maxBlockSize);
    this.input().set(mic.subarray(0, frames));
    this.process(frames);
    left.set(this.output(0).subarray(0, frames));
    right.set(this.output(1).subarray(0, frames));
  }

  /** Sets a value by its desktop parameter ID ("reverbOn", "tuneSpeed"...). False when unknown. */
  setValue(id: string, value: number): boolean {
    return this.x.micfx_set_value(this.handle, this.writeText(id), value) === 1;
  }

  /** The value's target, or undefined for an unknown ID. */
  getValue(id: string): number | undefined {
    const value = this.x.micfx_get_value(this.handle, this.writeText(id));
    return Number.isNaN(value) ? undefined : value;
  }

  /** Every value back to its default, except the input gain (it belongs to the mic). */
  resetValues(): void {
    this.x.micfx_reset_values(this.handle);
  }

  valueInfo(): ValueInfo[] {
    return this.readText(this.x.micfx_value_info(this.handle))
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id = "", value = "0", isSwitch = "0"] = line.split("=");
        return { id, defaultValue: Number(value), isSwitch: isSwitch === "1" };
      });
  }

  /** The effects' order as module keys ("highPass", "denoise"...), first to last. */
  setOrder(keys: string[]): void {
    this.x.micfx_set_order(this.handle, this.writeText(keys.join(",")));
  }

  getOrder(): string[] {
    return this.readText(this.x.micfx_get_order(this.handle)).split(",").filter(Boolean);
  }

  /** Peaks since the last call, and the effects' latency. */
  takeMeters(): Meters {
    const at = this.x.micfx_meters(this.handle);
    const m = new Float32Array(this.x.memory.buffer, at, 3);
    return { input: m[0]!, output: m[1]!, latencySamples: m[2]! };
  }

  dispose(): void {
    if (this.handle) this.x.micfx_destroy(this.handle);
    this.handle = 0;
  }

  private writeText(value: string): number {
    const length = Math.min(value.length, TEXT_SIZE - 1);
    const bytes = new Uint8Array(this.x.memory.buffer, this.x.micfx_text(), TEXT_SIZE);
    for (let i = 0; i < length; ++i) bytes[i] = value.charCodeAt(i) & 0x7f;
    bytes[length] = 0;
    return length;
  }

  private readText(length: number): string {
    const bytes = new Uint8Array(this.x.memory.buffer, this.x.micfx_text(), length);
    let text = "";
    for (let i = 0; i < length; i += 1024) text += String.fromCharCode(...bytes.subarray(i, Math.min(length, i + 1024)));
    return text;
  }
}
