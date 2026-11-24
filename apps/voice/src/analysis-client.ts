// The page's side of analysis-worker.ts: one worker, started the first time it's needed.
import type { FitChain, SoundCheckPlan } from "@micfx/engine/analysis";
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
