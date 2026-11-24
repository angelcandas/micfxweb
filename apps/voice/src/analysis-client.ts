// The page's side of analysis-worker.ts: one worker, started the first time it's needed.
import { Analysis, type FitChain, type SongSection, type SoundCheckPlan } from "@micfx/engine/analysis";
import analysisUrl from "@micfx/engine/analysis.wasm?url";
import type { AnalysisReply, AnalysisRequest } from "./analysis-worker";
import AnalysisWorker from "./analysis-worker?worker";

type Request = AnalysisRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;

let worker: Worker | undefined;
let nextId = 1;
const waiting = new Map<number, (reply: AnalysisReply) => void>();

function call(request: Request, transfer: Transferable[] = []): Promise<AnalysisReply> {
  if (!worker) {
    worker = new AnalysisWorker();
    worker.onmessage = (event: MessageEvent<AnalysisReply>) => {
      waiting.get(event.data.id)?.(event.data);
      waiting.delete(event.data.id);
    };
  }
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    worker!.postMessage({ ...request, id }, transfer);
  });
}

export async function soundCheckPlan(mono: Float32Array, sampleRate: number, options: { style?: number; fit?: FitChain }): Promise<SoundCheckPlan> {
  const reply = await call({ kind: "soundCheck", mono, sampleRate, ...options }, [mono.buffer as ArrayBuffer]);
  if ("error" in reply) throw new Error(reply.error);
  if (!("plan" in reply)) throw new Error("no plan");
  return reply.plan;
}

/** Practice: the melody in a voice (and the key, from the backing when there is one). */
export async function findMelody(voice: Float32Array, sampleRate: number, keyAudio?: Float32Array): Promise<{ melody: string; key: string }> {
  const transfer = [voice.buffer as ArrayBuffer, ...(keyAudio ? [keyAudio.buffer as ArrayBuffer] : [])];
  const reply = await call({ kind: "melody", voice, sampleRate, keyAudio }, transfer);
  if ("error" in reply) throw new Error(reply.error);
  if (!("melody" in reply)) throw new Error("no melody");
  return { melody: reply.melody, key: reply.key };
}

let onPage: Promise<Analysis> | undefined;

/** A copy of the analysis on the page itself, for quick calls every frame (Practice scoring). */
export function pageAnalysis(): Promise<Analysis> {
  onPage ??= (async () => {
    const response = await fetch(analysisUrl);
    if (!response.ok) throw new Error(`Couldn't load the analysis (${response.status})`);
    return new Analysis(await WebAssembly.compile(await response.arrayBuffer()));
  })();
  return onPage;
}

/** Practice: the song's sections (intro, verses, choruses...) from its audio. */
export async function songSections(mono: Float32Array, sampleRate: number): Promise<SongSection[]> {
  const reply = await call({ kind: "sections", mono, sampleRate }, [mono.buffer as ArrayBuffer]);
  if ("error" in reply) throw new Error(reply.error);
  if (!("sections" in reply)) throw new Error("no sections");
  return reply.sections;
}

/** Practice's key and speed: the audio warped and transposed (the DAW's Warp). */
export async function warpAudio(channels: Float32Array[], sampleRate: number, speed: number, semitones: number, voice: boolean): Promise<Float32Array[]> {
  const reply = await call({ kind: "warp", channels, sampleRate, speed, semitones, voice }, channels.map((c) => c.buffer as ArrayBuffer));
  if ("error" in reply) throw new Error(reply.error);
  if (!("warped" in reply)) throw new Error("no audio");
  return reply.warped;
}
