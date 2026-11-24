// The messages between the page and the engine's AudioWorkletProcessor.
import type { EngineStatus, FactoryPreset, Meters, ParameterInfo, ValueInfo } from "./engine";

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
  | { type: "loadPreset"; index: number };

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
  | ({ type: "meters"; status?: EngineStatus } & Meters);
