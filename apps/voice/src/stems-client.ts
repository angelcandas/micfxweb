// The stem splitter on the page: the desktop's Demucs model (downloaded once from where the
// desktop app gets it, checked by its SHA-256 and kept in this browser's private files), and
// a few Workers that separate the song's chunks at once.
import { STEMS_MODEL, planChunks, stitchChunks } from "@micfx/engine/stems";
import stemsUrl from "@micfx/engine/stems.wasm?url";
import type { StemsReply, StemsRequest } from "./stems-worker";
import StemsWorker from "./stems-worker?worker";

export type SplitPhase = "downloading" | "loading" | "splitting";
type Stereo = [Float32Array, Float32Array];

/**
 * How many Workers: each holds its own model and working memory (well over 1 GB while it
 * separates), and they all share the tab's memory, so two only on a machine with plenty
 * (browsers report 8 GB at most) and cores to spare.
 */
function workerCount(chunks: number): number {
  const cores = navigator.hardwareConcurrency || 2;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  return Math.max(1, Math.min(chunks, memory >= 8 && cores >= 8 ? 2 : 1));
}

/** The weights: from the browser's files, else downloaded (with progress) and kept. */
export async function stemsModel(progress: (p: number) => void, cancelled: () => boolean): Promise<ArrayBuffer> {
  const dir = await modelsDir();
  const kept = await dir?.getFileHandle(STEMS_MODEL.fileName).then((h) => h.getFile()).catch(() => undefined);
  if (kept && kept.size > 1_000_000) return kept.arrayBuffer();

  const response = await fetch(STEMS_MODEL.url);
  if (!response.ok || !response.body) throw new Error(`Couldn't download the separation model (${response.status}).`);
  const total = Number(response.headers.get("content-length")) || STEMS_MODEL.megabytes * 1_048_576;
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    if (cancelled()) {
      await reader.cancel();
      throw new DOMException("cancelled", "AbortError");
    }
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    progress(Math.min(0.99, received / total));
  }
  const bytes = new Uint8Array(received);
  let at = 0;
  for (const part of parts) bytes.set(part, (at += part.length) - part.length);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
  if (digest !== STEMS_MODEL.sha256) throw new Error("The separation model didn't download properly: try again.");
  if (dir) {
    try {
      const writable = await (await dir.getFileHandle(STEMS_MODEL.fileName, { create: true })).createWritable();
      await writable.write(bytes);
      await writable.close();
    } catch {
      // not kept: it downloads again next time
    }
  }
  return bytes.buffer;
}

async function modelsDir() {
  try {
    return await (await navigator.storage.getDirectory()).getDirectoryHandle("models", { create: true });
  } catch {
    return undefined;
  }
}

/**
 * Separates a stereo song at 44.1 kHz into its voice and the rest (drums, bass and other
 * together), as the desktop's Practice does. Throws an AbortError when cancelled.
 */
export async function splitVoice(song: Stereo, report: (phase: SplitPhase, progress: number) => void, cancelled: () => boolean): Promise<{ voice: Stereo; backing: Stereo }> {
  report("downloading", 0);
  const weights = await stemsModel((p) => report("downloading", p), cancelled);
  report("loading", 0);
  const module = await WebAssembly.compileStreaming(fetch(stemsUrl)).catch(async () => WebAssembly.compile(await (await fetch(stemsUrl)).arrayBuffer()));

  const total = song[0].length;
  const { chunks, overlap } = planChunks(total);
  const done = new Float32Array(chunks.length);
  const span = chunks.reduce((sum, c) => sum + c.to - c.from, 0);
  const progress = () => report("splitting", chunks.reduce((sum, c, k) => sum + done[k]! * (c.to - c.from), 0) / span);
  const results: [Float32Array, Float32Array][][] = new Array(chunks.length);
  const workers = Array.from({ length: workerCount(chunks.length) }, () => new StemsWorker());

  try {
    let next = 0;
    let failed: Error | undefined;
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((resolve, reject) => {
            const fail = (error: Error) => {
              failed ??= error;
              reject(error);
            };
            const send = () => {
              if (failed) return resolve();
              if (cancelled()) return fail(new DOMException("cancelled", "AbortError"));
              const k = next++;
              if (k >= chunks.length) return resolve();
              const { from, to } = chunks[k]!;
              worker.postMessage({ kind: "chunk", id: k, left: song[0].slice(from, to), right: song[1].slice(from, to) } satisfies StemsRequest);
            };
            worker.onerror = (event) => fail(new Error(event.message || "The stem splitter stopped (out of memory?)."));
            worker.onmessage = (event: MessageEvent<StemsReply>) => {
              const reply = event.data;
              if (reply.kind === "error") return fail(new Error(reply.error));
              if (reply.kind === "ready") {
                if (workers.indexOf(worker) === 0) report("splitting", 0);
                return send();
              }
              if (reply.kind === "progress") {
                done[reply.id] = Math.min(0.99, reply.progress);
                progress();
                if (cancelled()) fail(new DOMException("cancelled", "AbortError"));
                return;
              }
              results[reply.id] = reply.stems;
              done[reply.id] = 1;
              progress();
              send();
            };
            worker.postMessage({ kind: "init", module, weights: weights.slice(0) } satisfies StemsRequest);
          }),
      ),
    );
  } finally {
    for (const worker of workers) worker.terminate();
  }

  const stems = stitchChunks(chunks, results, total, overlap);
  const [drums, bass, other, vocals] = stems as [Stereo, Stereo, Stereo, Stereo];
  const backing: Stereo = [new Float32Array(total), new Float32Array(total)];
  for (const stem of [drums, bass, other]) for (let ch = 0; ch < 2; ++ch) for (let i = 0; i < total; ++i) backing[ch]![i]! += stem[ch]![i]!;
  return { voice: vocals, backing };
}

/**
 * Splitting a song into stems takes about 14 minutes in a browser, so it is off here: a song plays as it is,
 * with its voice taken down. "?split=1" (kept for next time as micfx.stemSplit) turns it back on.
 */
export function stemSplitEnabled(): boolean {
  try {
    if (/[?&]split=1\b/.test(location.search)) localStorage.setItem("micfx.stemSplit", "1");
    if (/[?&]split=0\b/.test(location.search)) localStorage.removeItem("micfx.stemSplit");
    return localStorage.getItem("micfx.stemSplit") === "1";
  } catch {
    return false;
  }
}
