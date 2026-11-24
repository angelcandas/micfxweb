// The messages between the page and the engine's AudioWorkletProcessor.
import type { MetronomeSettings } from "./metronome";
import type { EngineStatus, FactoryPreset, LooperCommand, LooperState, Meters, ParameterInfo, ValueInfo } from "./engine";
import type { TakeChunk, TakeEnd, TrackOptions, TransportAction } from "./session";

/** Desktop parameter IDs to values, in real units. */
export type Values = Record<string, number>;

export type ToWorklet =
  | { type: "set"; values: Values }
  /** Every value back to its default, then these, then the order (empty: standard). */
  | { type: "preset"; values: Values; order?: string[] }
  | { type: "order"; keys: string[] }
  /** Whether meters carry the engine status (tuner, effect readings); off by default. */
  | { type: "status"; on: boolean }
  /** A desktop factory preset by its index; "values" follows. */
  | { type: "loadPreset"; index: number }
  /** A track on the timeline (start in frames, channels at the context's rate); replaces one with the same id. */
  | { type: "addTrack"; id: number; channels: Float32Array[]; start: number; options?: TrackOptions }
  | { type: "removeTrack"; id: number }
  | { type: "setTrack"; id: number; options: TrackOptions }
  | { type: "transport"; action: TransportAction; seconds?: number }
  /** Loops from..to seconds (Practice); without them, the loop ends. */
  | { type: "loop"; from?: number; to?: number }
  /** Starts a take (and plays; after a count-in of `countIn` bars), or ends it: "takeChunk"s then "takeEnd" follow. */
  | { type: "record"; on: boolean; dry?: boolean; countIn?: number }
  /** Plays the calibration clicks and records them back: "calibration" follows. */
  | { type: "calibrate" }
  /** The click: on or off, its tempo, beats in a bar and level. */
  | ({ type: "metronome" } & MetronomeSettings)
  /** The looper: a button, a layer's gain or mute, or its tempo and volume. */
  | { type: "looper"; command: LooperCommand }
  | { type: "looperLayer"; layer: number; gain?: number; muted?: boolean }
  | { type: "looperSettings"; bpm?: number; beatsPerBar?: number; locked?: boolean; volume?: number }
  /** Every layer's audio: "looperLayers" follows. */
  | { type: "looperExport" }
  /** The raw mic, for a sound check: "micChunk"s of about 0.1 s while on. */
  | { type: "captureMic"; on: boolean }
  /** The Practice view's pitch tap: meters carry "pitch" readings while on. */
  | { type: "pitch"; on: boolean }
  /** A sound check's room profile (power per bin) for the denoiser. */
  | { type: "noiseProfile"; bins: Float32Array };

/** The transport, in seconds, as the desktop's meters event has it. */
export interface TransportState {
  position: number;
  length: number;
  playing: boolean;
}

export type FromWorklet =
  | {
      type: "ready";
      values: ValueInfo[];
      parameters: Record<string, ParameterInfo>;
      presets: FactoryPreset[];
      order: string[];
      sampleRate: number;
    }
  /** Every parameter's value and the order, after a preset changed them. */
  | { type: "values"; values: Values; order: string[] }
  | { type: "error"; message: string }
  | ({
      type: "meters";
      status?: EngineStatus;
      transport: TransportState;
      recording: number;
      /** Beats left of a take's count-in (0: none). */
      countIn: number;
      looper?: LooperState;
      /** While the pitch tap is on: [position (samples), midi, level dB] per 5 ms reading. */
      pitch?: Float64Array;
    } & Meters)
  | ({ type: "takeChunk" } & TakeChunk)
  | { type: "looperLayers"; layers: [Float32Array, Float32Array][]; sampleRate: number }
  | { type: "micChunk"; samples: Float32Array }
  | { type: "noiseProfileTaken"; ok: boolean }
  /** The mic while the calibration clicks played, and where they went out (frames). */
  | { type: "calibration"; mic: Float32Array; clicks: number[]; sampleRate: number }
  /** After the last chunk of a take; undefined fields when nothing was recording. */
  | ({ type: "takeEnd" } & Partial<TakeEnd>);
