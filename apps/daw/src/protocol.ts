// Messages between the page (main.ts) and the engine worker (engine-worker.ts).

/** What a desktop file chooser asks for (DawHost.cpp, juce::web::requestChooser). */
export interface ChooserRequest {
  title: string;
  start: string;
  patterns: string;
  save: boolean;
  folders: boolean;
  files: boolean;
  multiple: boolean;
}

/** Where the rings sit in the shared memory (micfx_daw_rings). */
export interface Rings {
  outWrite: number;
  outRead: number;
  outCapacity: number;
  outChannels: number;
  outData: number;
  inWrite: number;
  inRead: number;
  inCapacity: number;
  inChannels: number;
  inData: number;
}

export interface FileEntry {
  name: string;
  folder: boolean;
  size: number;
  modified: number;
}

export type ToWorker =
  | { type: "init"; sampleRate: number; opfs: boolean; base: string }
  | { type: "call"; id: number; name: string; args: unknown[] }
  | { type: "chooserResult"; id: number; paths: string[] }
  | { type: "audio"; targetFrames: number; inputChannels: number; roundTripFrames: number; paused: boolean }
  | { type: "midi"; status: number; data1: number; data2: number }
  | { type: "inputNames"; names: string[] }
  | { type: "writeFile"; reqId: number; path: string; data: ArrayBuffer }
  | { type: "readFile"; reqId: number; path: string }
  | { type: "list"; reqId: number; path: string }
  | { type: "remove"; reqId: number; path: string }
  | { type: "mkdir"; reqId: number; path: string };

export type FromWorker =
  | { type: "ready"; memory: WebAssembly.Memory; rings: Rings; persistent: boolean; home: string }
  | { type: "failed"; message: string }
  | { type: "complete"; id: number; json: string }
  | { type: "event"; name: string; json: string }
  | { type: "chooser"; id: number; request: ChooserRequest }
  | { type: "clipboard"; text: string }
  | { type: "load"; value: number }
  | { type: "reply"; reqId: number; ok: boolean; error?: string; data?: ArrayBuffer; entries?: FileEntry[] };
