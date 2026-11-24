// The engine worker: daw.wasm (the desktop DAW, see packages/engine/cpp/daw/DawHost.cpp).
//
// This worker's thread is JUCE's message thread: it delivers posted messages every few
// milliseconds and runs DawBridge::tick 30 times a second. The audio runs on a thread of the
// engine's own and reaches the page's AudioWorklet through rings in the shared memory.
import type { FromWorker, ToWorker, FileEntry } from "./protocol";

interface DawModule {
  ccall(name: string, ret: string | null, types: string[], args: unknown[]): number;
  _micfx_daw_dispatch(): number;
  _micfx_daw_tick(): void;
  _micfx_daw_load(): number;
  _micfx_daw_midi(status: number, data1: number, data2: number): void;
  _micfx_daw_audio_settings(target: number, inputs: number, roundTrip: number, paused: number): void;
  _micfx_daw_rings(out: number): void;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _micfx_daw_list(path: number): number;
  _micfx_daw_write(path: number, data: number, size: number): number;
  _micfx_daw_read(path: number, size: number): number;
  _micfx_daw_remove(path: number): number;
  _micfx_daw_mkdir(path: number): number;
  HEAP32: Int32Array;
  HEAPU8: Uint8Array;
  wasmMemory: WebAssembly.Memory;
  UTF8ToString(pointer: number): string;
  stringToUTF8(text: string, pointer: number, max: number): void;
  lengthBytesUTF8(text: string): number;
}

const post = (message: FromWorker) => (self as unknown as Worker).postMessage(message);
let module: DawModule | undefined;
const HOME = "/home/web";

async function start(sampleRate: number, opfs: boolean, base: string) {
  const url = new URL("engine/daw.mjs", base).href;
  const { default: createDawModule } = await import(/* @vite-ignore */ url);
  const m: DawModule = await createDawModule({
    locateFile: (file: string) => new URL(file, url).href,
    mainScriptUrlOrBlob: url,
    onDawComplete: (id: number, json: string) => post({ type: "complete", id, json }),
    onDawEvent: (name: string, json: string) => post({ type: "event", name, json }),
    onDawChooser: (id: number, json: string) => post({ type: "chooser", id, request: JSON.parse(json) }),
    onDawClipboard: (text: string) => post({ type: "clipboard", text }),
    print: (text: string) => console.log(`[MicFX DAW] ${text}`),
    printErr: (text: string) => console.warn(`[MicFX DAW] ${text}`),
  });
  module = m;

  const persistent = m.ccall("micfx_daw_mount", "number", ["number"], [opfs ? 1 : 0]) === 1;
  m.ccall("micfx_daw_create", "number", ["number", "number"], [sampleRate, 128]);

  const out = m._malloc(40);
  m._micfx_daw_rings(out);
  const r = Array.from(heap32(m).subarray(out >> 2, (out >> 2) + 10));
  m._free(out);
  const [outWrite, outRead, outCapacity, outChannels, outData, inWrite, inRead, inCapacity, inChannels, inData] = r as number[] as [
    number, number, number, number, number, number, number, number, number, number];

  // The message thread: messages and timers often, the bridge's tick at 30 Hz.
  setInterval(() => m._micfx_daw_dispatch(), 4);
  setInterval(() => m._micfx_daw_tick(), 33);
  setInterval(() => post({ type: "load", value: m._micfx_daw_load() / 1000 }), 500);

  post({
    type: "ready",
    memory: m.wasmMemory,
    rings: { outWrite, outRead, outCapacity, outChannels, outData, inWrite, inRead, inCapacity, inChannels, inData },
    persistent,
    home: HOME,
  });
}

// Fresh views each time: the memory grows (its buffer changes) while the DAW runs.
const heap8 = (m: DawModule) => new Uint8Array(m.wasmMemory.buffer);
const heap32 = (m: DawModule) => new Int32Array(m.wasmMemory.buffer);

// Files go through the engine's own C++ (JUCE on Emscripten's file system), so the page sees
// exactly what the DAW does.
function withPath<T>(m: DawModule, path: string, use: (pointer: number) => T): T {
  const size = m.lengthBytesUTF8(path) + 1;
  const pointer = m._malloc(size);
  m.stringToUTF8(path, pointer, size);
  try { return use(pointer); } finally { m._free(pointer); }
}

function fileCommand(message: Extract<ToWorker, { reqId: number }>) {
  const m = module!;
  const reply = (ok: boolean, extra: Partial<Extract<FromWorker, { type: "reply" }>> = {}, transfer: Transferable[] = []) =>
    (self as unknown as Worker).postMessage({ type: "reply", reqId: message.reqId, ok, ...extra } satisfies FromWorker, transfer);
  switch (message.type) {
    case "writeFile": {
      const bytes = new Uint8Array(message.data);
      const data = m._malloc(Math.max(1, bytes.length));
      heap8(m).set(bytes, data);
      const ok = withPath(m, message.path, (p) => m._micfx_daw_write(p, data, bytes.length)) === 1;
      m._free(data);
      reply(ok, ok ? {} : { error: `Couldn't write ${message.path}` });
      break;
    }
    case "readFile": {
      const sizeAt = m._malloc(4);
      const data = withPath(m, message.path, (p) => m._micfx_daw_read(p, sizeAt));
      const size = heap32(m)[sizeAt >> 2]!;
      m._free(sizeAt);
      if (size < 0) { reply(false, { error: `Couldn't read ${message.path}` }); break; }
      const copy = heap8(m).slice(data, data + size);
      m._free(data);
      reply(true, { data: copy.buffer }, [copy.buffer]);
      break;
    }
    case "list": {
      const json = withPath(m, message.path, (p) => m._micfx_daw_list(p));
      const entries = JSON.parse(m.UTF8ToString(json)) as FileEntry[];
      m._free(json);
      reply(true, { entries });
      break;
    }
    case "remove":
      reply(withPath(m, message.path, (p) => m._micfx_daw_remove(p)) === 1);
      break;
    case "mkdir":
      reply(withPath(m, message.path, (p) => m._micfx_daw_mkdir(p)) === 1);
      break;
  }
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.type === "init") {
    start(message.sampleRate, message.opfs, message.base).catch((error) => post({ type: "failed", message: String(error?.message ?? error) }));
    return;
  }
  const m = module;
  if (!m) return;
  switch (message.type) {
    case "call":
      m.ccall("micfx_daw_call", null, ["number", "string", "string"], [message.id, message.name, JSON.stringify(message.args ?? [])]);
      break;
    case "chooserResult":
      m.ccall("micfx_daw_chooser_result", null, ["number", "string"], [message.id, message.paths.join("\n")]);
      break;
    case "audio":
      m._micfx_daw_audio_settings(message.targetFrames, message.inputChannels, message.roundTripFrames, message.paused ? 1 : 0);
      break;
    case "midi":
      m._micfx_daw_midi(message.status, message.data1, message.data2);
      break;
    case "inputNames":
      m.ccall("micfx_daw_input_names", null, ["string"], [message.names.join("\n")]);
      break;
    default:
      fileCommand(message);
  }
};
