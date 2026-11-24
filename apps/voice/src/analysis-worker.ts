// The desktop's measuring and planning code (analysis.wasm) off the page's thread: the sound
// check's plan takes a few hundred milliseconds.
import { Analysis, type FitChain, type SoundCheckPlan } from "@micfx/engine/analysis";
import analysisUrl from "@micfx/engine/analysis.wasm?url";

export type AnalysisRequest =
  | { id: number; kind: "styles" }
  | { id: number; kind: "soundCheck"; mono: Float32Array; sampleRate: number; style?: number; fit?: FitChain };

export type AnalysisReply = { id: number; styles: string[] } | { id: number; plan: SoundCheckPlan } | { id: number; error: string };

let analysis: Promise<Analysis> | undefined;

function load() {
  analysis ??= (async () => {
    const response = await fetch(analysisUrl);
    if (!response.ok) throw new Error(`Couldn't load the analysis (${response.status})`);
    return new Analysis(await WebAssembly.compile(await response.arrayBuffer()));
  })();
  return analysis;
}

self.onmessage = async (event: MessageEvent<AnalysisRequest>) => {
  const request = event.data;
  let reply: AnalysisReply;
  try {
    const a = await load();
    if (request.kind === "styles") reply = { id: request.id, styles: a.styles() };
    else {
      const plan = a.soundCheck(request.mono, request.sampleRate, { style: request.style, fit: request.fit });
      reply = { id: request.id, plan };
    }
  } catch (error) {
    reply = { id: request.id, error: error instanceof Error ? error.message : String(error) };
  }
  const transfer = "plan" in reply ? [reply.plan.noiseProfile.buffer as ArrayBuffer] : [];
  self.postMessage(reply, { transfer });
};
