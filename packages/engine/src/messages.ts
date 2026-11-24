// The messages between the page and the engine's AudioWorkletProcessor.
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
  /** Starts a take (and plays), or ends it: "takeChunk"s then "takeEnd" follow. */
  | { type: "record"; on: boolean; dry?: boolean }
  /** The looper: a button, a layer's gain or mute, or its tempo and volume. */
  | { type: "looper"; command: LooperCommand }
  | { type: "looperLayer"; layer: number; gain?: number; muted?: boolean }
  | { type: "looperSettings"; bpm?: number; beatsPerBar?: number; locked?: boolean; volume?: number }
  /** Every layer's audio: "looperLayers" follows. */
  | { type: "looperExport" };

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
  | ({ type: "meters"; status?: EngineStatus; transport: TransportState; recording: number; looper?: LooperState } & Meters)
  | ({ type: "takeChunk" } & TakeChunk)
  | { type: "looperLayers"; layers: [Float32Array, Float32Array][]; sampleRate: number }
  /** After the last chunk of a take; undefined fields when nothing was recording. */
  | ({ type: "takeEnd" } & Partial<TakeEnd>);
