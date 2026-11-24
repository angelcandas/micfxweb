// One of the stem splitter's Workers: the network (stems.wasm) with its own copy of the
// weights, separating one chunk of the song at a time.
import { StemSeparator } from "@micfx/engine/stems";

export type StemsRequest = { kind: "init"; module: WebAssembly.Module; weights: ArrayBuffer } | { kind: "chunk"; id: number; left: Float32Array; right: Float32Array };

export type StemsReply =
  | { kind: "ready"; stems: number }
  | { kind: "progress"; id: number; progress: number }
  | { kind: "chunk"; id: number; stems: [Float32Array, Float32Array][] }
  | { kind: "error"; error: string };

let separator: StemSeparator | undefined;
let current = -1;
let last = 0;

self.onmessage = (event: MessageEvent<StemsRequest>) => {
  const request = event.data;
  try {
    if (request.kind === "init") {
      separator = new StemSeparator(request.module, (progress) => {
        // (a few times a second is plenty)
        const now = performance.now();
        if (now - last < 200) return;
        last = now;
        post({ kind: "progress", id: current, progress });
      });
      post({ kind: "ready", stems: separator.load(new Uint8Array(request.weights)) });
      return;
    }
    if (!separator) throw new Error("The separation model isn't loaded.");
    current = request.id;
    const stems = separator.separate(request.left, request.right);
    post({ kind: "chunk", id: request.id, stems }, stems.flatMap(([l, r]) => [l.buffer as ArrayBuffer, r.buffer as ArrayBuffer]));
  } catch (error) {
    post({ kind: "error", error: error instanceof Error ? error.message : String(error) });
  }
};

function post(reply: StemsReply, transfer: Transferable[] = []) {
  (self as unknown as Worker).postMessage(reply, transfer);
}
