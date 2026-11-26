// The ideas, kept in this browser: details in IndexedDB, the audio as a WAV file in OPFS
// (or, where a browser can't append to a file, as chunks in IndexedDB).
import { WAV_HEADER, wavHeader } from "./wav";
import WriterWorker from "./writer-worker?worker";
import type { WriterReply } from "./writer-worker";

export interface Idea {
  id: string;
  name: string;
  /** ms since 1970. */
  created: number;
  /** Seconds. */
  length: number;
  rate: number;
  starred: boolean;
  note: string;
  /** "A minor", from the analysis after the take. */
  key?: string;
  bpm?: number;
  /** Loudness bars, 0..100, about 240 across the take. */
  peaks: number[];
  /** Seconds where "Mark" was pressed. */
  markers: number[];
  status: "recording" | "saved" | "recovered";
  /** Set when deleted and waiting out the Undo. */
  deleted?: number;
  /** The idea this one was layered over. */
  parent?: string;
  /** Where the take went wrong (a call, the screen locking). */
  interrupted?: number;
  /** Set once the analysis has run. */
  analysed?: boolean;
}

const DB = "micfx-ideas";
let db: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("ideas", { keyPath: "id" });
      request.result.createObjectStore("chunks", { keyPath: ["id", "seq"] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return db;
}

async function run<T>(stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
  const database = await open();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(stores, mode);
    const request = work(tx);
    tx.oncomplete = () => resolve(request ? (request.result as T) : (undefined as T));
    tx.onerror = () => reject(tx.error);
  });
}

export const listIdeas = () => run<Idea[]>(["ideas"], "readonly", (tx) => tx.objectStore("ideas").getAll());
export const saveIdea = (idea: Idea) => run(["ideas"], "readwrite", (tx) => { tx.objectStore("ideas").put(idea); });

export async function getIdea(id: string): Promise<Idea | undefined> {
  return run<Idea | undefined>(["ideas"], "readonly", (tx) => tx.objectStore("ideas").get(id));
}

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function defaultName(date = new Date()): string {
  const day = date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `Idea · ${day}, ${time}`;
}

const hasOpfs = () => typeof navigator.storage?.getDirectory === "function";

async function opfsFile(id: string): Promise<File | undefined> {
  if (!hasOpfs()) return undefined;
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("ideas");
    return await (await dir.getFileHandle(`${id}.wav`)).getFile();
  } catch {
    return undefined;
  }
}

async function chunkBlobs(id: string): Promise<Blob[]> {
  const chunks = await run<{ id: string; seq: number; pcm: ArrayBuffer }[]>(["chunks"], "readonly", (tx) =>
    tx.objectStore("chunks").getAll(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])));
  return chunks.sort((a, b) => a.seq - b.seq).map((c) => new Blob([c.pcm]));
}

/** The idea's audio as a WAV. */
export async function readAudio(idea: Idea): Promise<Blob> {
  const file = await opfsFile(idea.id);
  if (file) return new Blob([file], { type: "audio/wav" });
  const parts = await chunkBlobs(idea.id);
  const bytes = parts.reduce((n, p) => n + p.size, 0);
  return new Blob([wavHeader(idea.rate, bytes / 2) as BlobPart, ...parts], { type: "audio/wav" });
}

export async function removeAudio(id: string): Promise<void> {
  if (hasOpfs()) {
    try {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("ideas");
      await dir.removeEntry(`${id}.wav`);
    } catch { /* not there */ }
  }
  await run(["chunks"], "readwrite", (tx) => { tx.objectStore("chunks").delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])); });
}

export async function deleteIdea(id: string): Promise<void> {
  await removeAudio(id);
  await run(["ideas"], "readwrite", (tx) => { tx.objectStore("ideas").delete(id); });
}

/** Appends PCM to an idea's audio as it's recorded. */
export interface AudioWriter {
  write(pcm: Int16Array): void;
  /** Resolves with the frames written. */
  close(): Promise<number>;
}

export async function openWriter(id: string, rate: number): Promise<AudioWriter> {
  if (hasOpfs()) {
    try {
      const worker = new WriterWorker();
      const first = await new Promise<WriterReply>((resolve) => {
        worker.onmessage = (event: MessageEvent<WriterReply>) => resolve(event.data);
        worker.postMessage({ t: "open", id, rate });
      });
      if (first.t === "opened") {
        let done: ((frames: number) => void) | undefined;
        worker.onmessage = (event: MessageEvent<WriterReply>) => {
          if (event.data.t === "closed") { done?.(event.data.frames); worker.terminate(); }
        };
        return {
          write: (pcm) => worker.postMessage({ t: "pcm", pcm }, [pcm.buffer]),
          close: () => new Promise((resolve) => { done = resolve; worker.postMessage({ t: "close" }); }),
        };
      }
      worker.terminate();
    } catch { /* fall through to IndexedDB */ }
  }
  let seq = 0;
  let frames = 0;
  let pending = Promise.resolve();
  return {
    write: (pcm) => {
      const at = seq++;
      frames += pcm.length;
      pending = pending.then(() => run(["chunks"], "readwrite", (tx) => { tx.objectStore("chunks").put({ id, seq: at, pcm: pcm.buffer }); }));
    },
    close: async () => { await pending; return frames; },
  };
}

/** Takes left open by a crash, a call or a dead battery are kept, as "recovered". */
export async function recoverIdeas(): Promise<void> {
  const all = await listIdeas();
  for (const idea of all) {
    if (idea.deleted) { await deleteIdea(idea.id); continue; }
    if (idea.status !== "recording") continue;
    const file = await opfsFile(idea.id);
    let bytes = 0;
    if (file) bytes = Math.max(0, file.size - WAV_HEADER);
    else bytes = (await chunkBlobs(idea.id)).reduce((n, p) => n + p.size, 0);
    if (bytes < idea.rate * 2 * 0.5) { await deleteIdea(idea.id); continue; } // under half a second
    await saveIdea({ ...idea, status: "recovered", length: bytes / 2 / idea.rate });
  }
}

/** Asks the browser not to clear the ideas when storage runs low. */
export async function keepStorage(): Promise<boolean> {
  try { return (await navigator.storage?.persist?.()) ?? false; } catch { return false; }
}

export async function storageLeft(): Promise<number | undefined> {
  try {
    const { quota, usage } = await navigator.storage.estimate();
    return quota !== undefined && usage !== undefined ? quota - usage : undefined;
  } catch { return undefined; }
}
