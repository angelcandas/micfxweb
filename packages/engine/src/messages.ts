// The messages between the page and the engine's AudioWorkletProcessor.
import type { Meters, ValueInfo } from "./engine";

/** Desktop parameter IDs to values, in real units. */
export type Values = Record<string, number>;

export type ToWorklet =
  | { type: "set"; values: Values }
  /** Every value back to its default, then these, then the order (empty: standard). */
  | { type: "preset"; values: Values; order?: string[] }
  | { type: "order"; keys: string[] };

export type FromWorklet =
  | { type: "ready"; values: ValueInfo[]; order: string[]; sampleRate: number }
  | { type: "error"; message: string }
  | ({ type: "meters" } & Meters);
