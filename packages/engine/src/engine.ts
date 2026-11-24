// Loads engine.wasm (the desktop MicFX DSP compiled to WebAssembly) and wraps its C API.
//
// Runs anywhere WebAssembly does: the AudioWorklet (the app), Node (the tests). It uses no
// TextEncoder/TextDecoder because AudioWorkletGlobalScope doesn't have them in every
// browser; the IDs crossing the boundary are ASCII.

export interface ValueInfo {
  id: string;
  defaultValue: number;
  isSwitch: boolean;
  /** The module's key ("reverb", "pitch"...), "" for the input and output gains. */
  module: string;
}

/** One desktop parameter, as the desktop's "getParameterInfo" native function describes it. */
export interface ParameterInfo {
  name: string;
  min: number;
  max: number;
  skew: number;
  step: number;
  label: string;
  default: number;
  choices?: string[];
  bool?: true;
}

/** A desktop factory preset: values in real units, and the effects' order (empty: standard). */
export interface FactoryPreset {
  name: string;
  category: string;
  values: Record<string, number>;
  order: string[];
}

/** A song's key, from the desktop's analysis::detectKey. */
export interface KeyEstimate {
  ok: boolean;
  /** Tonic, 0 = C ... 11 = B; -1 when there is no clear key. */
  key: number;
  minor: boolean;
  /** "A minor", "E♭ major"... */
  name: string;
  /** 0..1: how far the best key stands out from the next. */
  confidence: number;
}

/** The looper's buttons, as the desktop's Looper::Command. */
export const LOOPER_COMMANDS = ["main", "stop", "play", "undo", "redo", "clear"] as const;
export type LooperCommand = (typeof LOOPER_COMMANDS)[number];

/** The desktop's describeLooper(). Times in seconds. */
export interface LooperState {
  state: "empty" | "recording" | "closing" | "playing" | "overdubbing" | "stopped";
  layers: number;
  redo: number;
  maxLayers: number;
  length: number;
  position: number;
  closing: number;
  maxSeconds: number;
  bpm: number;
  beatsPerBar: number;
  locked: boolean;
  volume: number;
  gains: number[];
  mutes: boolean[];
  /** Each layer's 96 peaks, when asked for. */
  overviews?: number[][];
}

export interface EngineStatus {
  /** The sung note (MIDI, fractional), -1 when none. */
  note: number;
  /** The note autotune aims at, -1 when none. */
  target: number;
  /** The harmonizer's voices' notes, -1 for silent. */
  voices: number[];
  fx: Record<string, unknown>;
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
  malloc(bytes: number): number;
  free(pointer: number): void;
  micfx_detect_key(samples: number, frames: number, sampleRate: number): number;
  micfx_looper_command(engine: number, command: number): number;
  micfx_looper_layer(engine: number, layer: number, gain: number, muted: number): void;
  micfx_looper_settings(engine: number, bpm: number, beatsPerBar: number, locked: number, volume: number): void;
  micfx_looper_state(engine: number, withOverview: number): number;
  micfx_looper_copy(engine: number, layer: number): number;
  micfx_looper_copied(engine: number, channel: number): number;
  micfx_text(): number;
  micfx_result(): number;
  micfx_parameter_info(engine: number): number;
  micfx_presets(): number;
  micfx_load_preset(engine: number, index: number): number;
  micfx_status(engine: number): number;
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

  /** The desktop parameters, in the desktop's order. */
  parameterInfo(): Record<string, ParameterInfo> {
    return JSON.parse(this.readResult(this.x.micfx_parameter_info(this.handle))) as Record<string, ParameterInfo>;
  }

  /** The desktop's factory voice presets, in program order. */
  factoryPresets(): FactoryPreset[] {
    return JSON.parse(this.readResult(this.x.micfx_presets())) as FactoryPreset[];
  }

  /** Loads a factory preset as the desktop does: defaults (but the input gain), its values, its order. */
  loadPreset(index: number): boolean {
    return this.x.micfx_load_preset(this.handle, index) === 1;
  }

  /** Every value back to its default, except the input gain (it belongs to the mic). */
  resetValues(): void {
    this.x.micfx_reset_values(this.handle);
  }

  valueInfo(): ValueInfo[] {
    return this.readResult(this.x.micfx_value_info(this.handle))
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id = "", value = "0", isSwitch = "0", module = ""] = line.split("=");
        return { id, defaultValue: Number(value), isSwitch: isSwitch === "1", module };
      });
  }

  /** The effects' order as module keys ("highPass", "denoise"...), first to last. */
  setOrder(keys: string[]): void {
    this.x.micfx_set_order(this.handle, this.writeText(keys.join(",")));
  }

  getOrder(): string[] {
    return this.readResult(this.x.micfx_get_order(this.handle)).split(",").filter(Boolean);
  }

  /**
   * The tuner and the effect cards' live readings, as the desktop's "meters" event has them:
   * { note, target, voices, fx: { moduleKey: reading } } (only effects that are on).
   */
  status(): EngineStatus {
    return JSON.parse(this.readResult(this.x.micfx_status(this.handle))) as EngineStatus;
  }

  /** Peaks since the last call, and the effects' latency. */
  takeMeters(): Meters {
    const at = this.x.micfx_meters(this.handle);
    const m = new Float32Array(this.x.memory.buffer, at, 3);
    return { input: m[0]!, output: m[1]!, latencySamples: m[2]! };
  }

  /** A looper button; false when the command queue is full. */
  looperCommand(command: LooperCommand): boolean {
    const index = LOOPER_COMMANDS.indexOf(command);
    return index >= 0 && this.x.micfx_looper_command(this.handle, index) === 1;
  }

  looperLayer(layer: number, options: { gain?: number; muted?: boolean }): void {
    this.x.micfx_looper_layer(this.handle, layer, options.gain ?? -1, options.muted === undefined ? -1 : options.muted ? 1 : 0);
  }

  looperSettings(options: { bpm?: number; beatsPerBar?: number; locked?: boolean; volume?: number }): void {
    this.x.micfx_looper_settings(this.handle, options.bpm ?? -1, options.beatsPerBar ?? -1, options.locked === undefined ? -1 : options.locked ? 1 : 0, options.volume ?? -1);
  }

  looperState(withOverview = false): LooperState {
    return JSON.parse(this.readResult(this.x.micfx_looper_state(this.handle, withOverview ? 1 : 0))) as LooperState;
  }

  /** One pass of every looper layer, stereo (for saving them). */
  looperLayers(): [Float32Array, Float32Array][] {
    const layers: [Float32Array, Float32Array][] = [];
    for (let layer = 0; layer < 4; ++layer) {
      const frames = this.x.micfx_looper_copy(this.handle, layer);
      if (!frames) break;
      const channel = (c: number) => new Float32Array(this.x.memory.buffer, this.x.micfx_looper_copied(this.handle, c), frames).slice();
      layers.push([channel(0), channel(1)]);
    }
    return layers;
  }

  /** The key of a song (mono samples). Takes a moment: a few hundred ms for a song. */
  detectKey(mono: Float32Array, sampleRate: number): KeyEstimate {
    const at = this.x.malloc(mono.length * 4);
    if (!at) return { ok: false, key: -1, minor: false, name: "", confidence: 0 };
    try {
      new Float32Array(this.x.memory.buffer, at, mono.length).set(mono);
      const { confidencePerMille, ...key } = JSON.parse(this.readResult(this.x.micfx_detect_key(at, mono.length, sampleRate))) as Omit<KeyEstimate, "confidence"> & { confidencePerMille: number };
      return { ...key, confidence: confidencePerMille / 1000 };
    } finally {
      this.x.free(at);
    }
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

  // UTF-8, decoded by hand: some worklets have no TextDecoder.
  private readResult(length: number): string {
    const bytes = new Uint8Array(this.x.memory.buffer, this.x.micfx_result(), length);
    const codes: number[] = [];
    for (let i = 0; i < length; ) {
      const b = bytes[i++]!;
      if (b < 0x80) codes.push(b);
      else if (b < 0xe0) codes.push(((b & 0x1f) << 6) | (bytes[i++]! & 0x3f));
      else if (b < 0xf0) codes.push(((b & 0x0f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f));
      else {
        const c = ((b & 0x07) << 18) | ((bytes[i++]! & 0x3f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f);
        codes.push(0xd800 + ((c - 0x10000) >> 10), 0xdc00 + ((c - 0x10000) & 0x3ff));
      }
    }
    let text = "";
    for (let i = 0; i < codes.length; i += 4096) text += String.fromCharCode(...codes.slice(i, i + 4096));
    return text;
  }

}
