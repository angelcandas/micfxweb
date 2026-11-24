// analysis.wasm: the desktop's measuring and planning code (src/analysis), for a Web Worker.
// Each call takes a moment (a sound check's plan: well under a second for 15 s of voice),
// so it runs off the page's thread.
import { makeImports } from "./engine";

interface Exports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  malloc(bytes: number): number;
  free(pointer: number): void;
  micfx_result(): number;
  micfx_styles(): number;
  micfx_sound_check(
    samples: number,
    frames: number,
    sampleRate: number,
    style: number,
    fit: number,
    inputGainDb: number,
    minInputDb: number,
    maxInputDb: number,
    gate: number,
    classicDeEsser: number,
    denoise: number,
    lowCutHz: number,
  ): number;
  micfx_noise_profile(): number;
  micfx_find_melody(samples: number, frames: number, sampleRate: number, keySamples: number, keyFrames: number): number;
  micfx_score_song(text: number, length: number): number;
  micfx_score_frames(frames: number, count: number, songTime: number): void;
  micfx_score_restart(songTime: number): void;
  micfx_score_time(songTime: number): void;
  micfx_score_changes(all: number): number;
  micfx_score_report(): number;
}

/** A melody as the Practice view draws it: [start, end, pitch, phrase] per note, [start, end] per phrase. */
export interface PracticeSong {
  notes: number[];
  phrases: number[];
  lowest: number;
  highest: number;
}

/** The desktop's describeScores. */
export interface PracticeScores {
  reset: boolean;
  from: number;
  notes: Record<string, number | boolean>[];
  phrases: Record<string, number | boolean>[];
  pass: number;
}

/**
 * The Auto Mix styles, in the order a sound check's `style` counts them (analysis::allStyles).
 * Kept here so the page can list them without loading the wasm; the tests check it matches.
 */
export const MIX_STYLES = ["Pop", "Ballad", "Rock", "Voice up front", "Hip-hop", "R&B", "Acoustic", "Electronic", "Jazz", "Lo-fi", "Speech / podcast"];

/** What the Live chain has now, for a sound check that only fits its levels. */
export interface FitChain {
  inputGainDb: number;
  minInputDb: number;
  maxInputDb: number;
  gate: boolean;
  classicDeEsser: boolean;
  denoise: boolean;
  /** The high-pass in front of the denoiser, 0 when it's off. */
  lowCutHz: number;
}

/** The desktop's SoundCheck::Plan. */
export interface SoundCheckPlan {
  error: string;
  /** Parameter ID and value (real units), in chain order. */
  values: [string, number][];
  changes: { module: string; text: string }[];
  notes: string[];
  advice: string;
  peak: number;
  lufs: number;
  noise: number;
  sung: number;
  /** The room's profile for the denoiser (power per bin), empty when it isn't used. */
  noiseProfile: Float32Array;
}

export class Analysis {
  private readonly x: Exports;

  constructor(module: WebAssembly.Module) {
    let exports: Exports | undefined;
    const instance = new WebAssembly.Instance(module, makeImports(() => exports!.memory));
    exports = instance.exports as unknown as Exports;
    exports._initialize();
    this.x = exports;
  }

  /** The Auto Mix style names, in the order sound check's `style` counts them. */
  styles(): string[] {
    return JSON.parse(this.read(this.x.micfx_styles())) as string[];
  }

  /** The desktop's SoundCheck::makePlan (a style) or makeFitPlan (`fit`: keep the chain, fit its levels). */
  soundCheck(mono: Float32Array, sampleRate: number, options: { style?: number; fit?: FitChain }): SoundCheckPlan {
    const at = this.x.malloc(Math.max(1, mono.length) * 4);
    if (!at) return emptyPlan("Not enough memory for the sound check.");
    try {
      new Float32Array(this.x.memory.buffer, at, mono.length).set(mono);
      const f = options.fit;
      const length = this.x.micfx_sound_check(
        at,
        mono.length,
        sampleRate,
        options.style ?? 0,
        f ? 1 : 0,
        f?.inputGainDb ?? 0,
        f?.minInputDb ?? -24,
        f?.maxInputDb ?? 24,
        f?.gate ? 1 : 0,
        f?.classicDeEsser ? 1 : 0,
        f?.denoise ? 1 : 0,
        f?.lowCutHz ?? 0,
      );
      const { noiseBins, ...plan } = JSON.parse(this.read(length)) as Omit<SoundCheckPlan, "noiseProfile"> & { noiseBins: number };
      const noiseProfile = new Float32Array(this.x.memory.buffer, this.x.micfx_noise_profile(), noiseBins).slice();
      return { ...plan, noiseProfile };
    } finally {
      this.x.free(at);
    }
  }

  /**
   * Practice: the melody to sing in a voice (Song::toString text, "" when there's none) and
   * the song's key (from `keyAudio`, the backing, when given; else the voice).
   */
  findMelody(voice: Float32Array, sampleRate: number, keyAudio?: Float32Array): { melody: string; key: string } {
    const at = this.copyIn(voice);
    const keyAt = keyAudio?.length ? this.copyIn(keyAudio) : 0;
    try {
      return JSON.parse(this.read(this.x.micfx_find_melody(at, voice.length, sampleRate, keyAt, keyAt ? keyAudio!.length : 0))) as { melody: string; key: string };
    } finally {
      this.x.free(at);
      if (keyAt) this.x.free(keyAt);
    }
  }

  /** Practice scoring: the song to score from now on (its melody text). */
  scoreSong(melody: string): PracticeSong {
    const bytes = new TextEncoder().encode(melody);
    const at = this.x.malloc(Math.max(1, bytes.length));
    try {
      new Uint8Array(this.x.memory.buffer, at, bytes.length).set(bytes);
      return JSON.parse(this.read(this.x.micfx_score_song(at, bytes.length))) as PracticeSong;
    } finally {
      this.x.free(at);
    }
  }

  /** Sung frames ([time, midi] pairs, song time) up to `songTime`; notes that ended are scored. */
  scoreFrames(frames: Float64Array, songTime: number): void {
    const at = this.x.malloc(Math.max(8, frames.length * 8));
    try {
      new Float64Array(this.x.memory.buffer, at, frames.length).set(frames);
      this.x.micfx_score_frames(at, frames.length / 2, songTime);
    } finally {
      this.x.free(at);
    }
  }

  scoreRestart(songTime: number): void {
    this.x.micfx_score_restart(songTime);
  }

  scoreTime(songTime: number): void {
    this.x.micfx_score_time(songTime);
  }

  /** Every score so far (all), or what changed since the last call (undefined when nothing did). */
  scoreChanges(all = false): PracticeScores | undefined {
    const length = this.x.micfx_score_changes(all ? 1 : 0);
    return length < 0 ? undefined : (JSON.parse(this.read(length)) as PracticeScores);
  }

  scoreReport(): Record<string, unknown> {
    return JSON.parse(this.read(this.x.micfx_score_report())) as Record<string, unknown>;
  }

  private copyIn(samples: Float32Array): number {
    const at = this.x.malloc(Math.max(1, samples.length) * 4);
    if (!at) throw new Error("Not enough memory for the analysis.");
    new Float32Array(this.x.memory.buffer, at, samples.length).set(samples);
    return at;
  }

  private read(length: number): string {
    return new TextDecoder().decode(new Uint8Array(this.x.memory.buffer, this.x.micfx_result(), length));
  }
}

function emptyPlan(error: string): SoundCheckPlan {
  return { error, values: [], changes: [], notes: [], advice: "", peak: -200, lufs: -200, noise: -200, sung: 0, noiseProfile: new Float32Array(0) };
}
