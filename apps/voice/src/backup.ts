// Everything MicFX Voice keeps in this browser, as one .micfxbackup file and back (plan
// section 9, point 5), and what it all weighs (point 6). Three places hold it:
//   localStorage    "micfx.*": presets, sounds, scenes, setlist, MIDI map, preferences
//   IndexedDB       "micfx-voice": the sing-along tracks and takes, the setlist's backing files
//   private files   (OPFS) practice/: the Practice library; models/: the stem splitter's
//                   weights, which download again and so stay out of a backup
import { readZip, writeZip, type ZipEntry } from "./zip";

const PREFIX = "micfx.";
const DB_NAME = "micfx-voice";
const TRACKS = "tracks";
const SONG_FILES = "songFiles";
const MANIFEST = "micfx-backup.json";
/** OPFS folders that go in a backup. */
const KEPT_FOLDERS = ["practice"];

interface Manifest {
  format: "micfx-backup";
  version: 1;
  app: string;
  made: string;
  storage: Record<string, string>;
  tracks: { meta: Record<string, unknown>; audio: string; dry?: string }[];
  songFiles: { key: IDBValidKey; path: string }[];
  files: string[];
}

export interface BackupSummary {
  made: string;
  tracks: number;
  songs: number;
  settings: number;
}

// ----- the three stores ------------------------------------------------------------------

function local(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function ownKeys(storage: Storage): string[] {
  return Array.from({ length: storage.length }, (_, i) => storage.key(i)!).filter((key) => key?.startsWith(PREFIX));
}

function openDb(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(DB_NAME, 2);
      open.onupgradeneeded = () => {
        const names = open.result.objectStoreNames;
        if (!names.contains(TRACKS)) open.result.createObjectStore(TRACKS, { keyPath: "id" });
        if (!names.contains(SONG_FILES)) open.result.createObjectStore(SONG_FILES);
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readStore(db: IDBDatabase, name: string): Promise<{ key: IDBValidKey; value: unknown }[]> {
  if (!db.objectStoreNames.contains(name)) return [];
  const store = db.transaction(name, "readonly").objectStore(name);
  const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
  return keys.map((key, i) => ({ key, value: values[i] }));
}

async function root(): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    return await navigator.storage.getDirectory();
  } catch {
    return undefined;
  }
}

/** Every file under `dir`, with its path from there. */
async function walk(dir: FileSystemDirectoryHandle, path = ""): Promise<{ path: string; file: File }[]> {
  const out: { path: string; file: File }[] = [];
  for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    const at = path ? `${path}/${name}` : name;
    if (handle.kind === "directory") out.push(...(await walk(handle as FileSystemDirectoryHandle, at)));
    else out.push({ path: at, file: await (handle as FileSystemFileHandle).getFile() });
  }
  return out;
}

async function folder(path: string, create: boolean): Promise<FileSystemDirectoryHandle | undefined> {
  let dir = await root();
  for (const part of path.split("/").filter(Boolean)) {
    if (!dir) return undefined;
    dir = await dir.getDirectoryHandle(part, { create }).catch(() => undefined);
  }
  return dir;
}

const safePart = (name: string) => name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "-").slice(0, 80) || "file";

// ----- backup ----------------------------------------------------------------------------

/** One file with everything kept here (the splitter's model aside). */
export async function makeBackup(app = "MicFX Voice"): Promise<Blob> {
  const storage = local();
  const manifest: Manifest = { format: "micfx-backup", version: 1, app, made: new Date().toISOString(), storage: {}, tracks: [], songFiles: [], files: [] };
  const entries: ZipEntry[] = [];
  if (storage) for (const key of ownKeys(storage)) manifest.storage[key] = storage.getItem(key) ?? "";

  const db = await openDb();
  if (db) {
    try {
      for (const { value } of await readStore(db, TRACKS)) {
        const { audio, dry, ...meta } = value as Record<string, unknown> & { id: number; fileName?: string; dryFileName?: string; audio?: Blob; dry?: Blob };
        if (!(audio instanceof Blob)) continue;
        const row: Manifest["tracks"][number] = { meta, audio: `tracks/${meta.id}/${safePart(meta.fileName ?? "audio.wav")}` };
        entries.push({ name: row.audio, data: audio });
        if (dry instanceof Blob) {
          row.dry = `tracks/${meta.id}/dry-${safePart(meta.dryFileName ?? "dry.wav")}`;
          entries.push({ name: row.dry, data: dry });
        }
        manifest.tracks.push(row);
      }
      let n = 0;
      for (const { key, value } of await readStore(db, SONG_FILES)) {
        if (!(value instanceof Blob)) continue;
        const name = (value as Blob & { name?: string }).name;
        const path = `songs/${++n}-${safePart(name ?? String(key))}`;
        manifest.songFiles.push({ key, path });
        entries.push({ name: path, data: value });
      }
    } finally {
      db.close();
    }
  }

  const top = await root();
  for (const name of KEPT_FOLDERS) {
    const dir = await top?.getDirectoryHandle(name).catch(() => undefined);
    if (!dir) continue;
    for (const { path, file } of await walk(dir, name)) {
      manifest.files.push(path);
      entries.push({ name: `files/${path}`, data: file });
    }
  }
  entries.unshift({ name: MANIFEST, data: new Blob([JSON.stringify(manifest, null, 1)], { type: "application/json" }) });
  return writeZip(entries);
}

/** What's in a backup, before it's restored. Throws when the file isn't one. */
export async function readBackup(file: Blob): Promise<{ summary: BackupSummary; restore: () => Promise<void> }> {
  const entries = await readZip(file);
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  const head = byName.get(MANIFEST);
  if (!head) throw new Error("This isn't a MicFX backup.");
  const manifest = JSON.parse(await head.text()) as Manifest;
  if (manifest.format !== "micfx-backup" || manifest.version !== 1) throw new Error("This backup is from a newer MicFX: update the app first.");
  const songs = new Set(manifest.files.filter((f) => f.startsWith("practice/")).map((f) => f.split("/")[1]));
  const summary: BackupSummary = { made: manifest.made, tracks: manifest.tracks.length, songs: songs.size, settings: Object.keys(manifest.storage).length };
  const data = (path: string) => {
    const blob = byName.get(path);
    if (!blob) throw new Error(`The backup is missing ${path}.`);
    return blob;
  };
  return { summary, restore: () => restore(manifest, data) };
}

/**
 * Puts a backup in place: settings, tracks and the setlist's files replace what's here (they
 * refer to each other), Practice songs are added beside the ones already kept. The page
 * should reload afterwards.
 */
async function restore(manifest: Manifest, data: (path: string) => Blob): Promise<void> {
  const storage = local();
  if (storage) {
    for (const key of ownKeys(storage)) storage.removeItem(key);
    for (const [key, value] of Object.entries(manifest.storage)) if (key.startsWith(PREFIX)) storage.setItem(key, value);
  }

  const db = await openDb();
  if (db) {
    try {
      const tx = db.transaction([TRACKS, SONG_FILES], "readwrite");
      const tracks = tx.objectStore(TRACKS);
      const songFiles = tx.objectStore(SONG_FILES);
      tracks.clear();
      songFiles.clear();
      for (const row of manifest.tracks) {
        const value: Record<string, unknown> = { ...row.meta, audio: data(row.audio) };
        if (row.dry) value.dry = data(row.dry);
        tracks.put(value);
      }
      for (const { key, path } of manifest.songFiles) songFiles.put(data(path), key);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("The browser didn't keep the tracks."));
        tx.onabort = () => reject(tx.error ?? new Error("The browser's storage is full."));
      });
    } finally {
      db.close();
    }
  }

  for (const path of manifest.files) {
    if (!KEPT_FOLDERS.some((name) => path.startsWith(`${name}/`)) || path.split("/").includes("..")) continue;
    const parts = path.split("/");
    const dir = await folder(parts.slice(0, -1).join("/"), true);
    if (!dir) throw new Error("This browser won't keep the Practice songs (private files are blocked).");
    const writable = await (await dir.getFileHandle(parts.at(-1)!, { create: true })).createWritable();
    await writable.write(data(`files/${path}`));
    await writable.close();
  }
}

// ----- what's kept -----------------------------------------------------------------------

export type StoredKind = "practice" | "track" | "take" | "setlist" | "model" | "settings";

export interface StoredItem {
  kind: StoredKind;
  /** The practice folder, the track's id: what `forget` takes. */
  id: string;
  name: string;
  bytes: number;
  /** False for the parts that the rest depends on (settings, the setlist's files). */
  removable: boolean;
}

export interface StorageReport {
  items: StoredItem[];
  /** The browser's own numbers, when it gives them. */
  used?: number;
  quota?: number;
  persisted: boolean;
}

export async function storageReport(): Promise<StorageReport> {
  const items: StoredItem[] = [];
  const storage = local();
  if (storage) {
    const keys = ownKeys(storage);
    // localStorage holds UTF-16
    const bytes = keys.reduce((sum, key) => sum + 2 * (key.length + (storage.getItem(key)?.length ?? 0)), 0);
    if (keys.length) items.push({ kind: "settings", id: "settings", name: "Presets, sounds, scenes and settings", bytes, removable: false });
  }

  const db = await openDb();
  if (db) {
    try {
      for (const { value } of await readStore(db, TRACKS)) {
        const track = value as { id: number; name?: string; isTake?: boolean; audio?: Blob; dry?: Blob };
        items.push({ kind: track.isTake ? "take" : "track", id: String(track.id), name: track.name || "Track", bytes: (track.audio?.size ?? 0) + (track.dry?.size ?? 0), removable: true });
      }
      const files = await readStore(db, SONG_FILES);
      const bytes = files.reduce((sum, { value }) => sum + (value instanceof Blob ? value.size : 0), 0);
      if (files.length) items.push({ kind: "setlist", id: "setlist", name: `Setlist backing tracks (${files.length})`, bytes, removable: false });
    } finally {
      db.close();
    }
  }

  const top = await root();
  const practice = await top?.getDirectoryHandle("practice").catch(() => undefined);
  if (practice)
    for await (const [name, handle] of (practice as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (handle.kind !== "directory") continue;
      const files = await walk(handle as FileSystemDirectoryHandle);
      const info = files.find((f) => f.path === "info.json");
      let title = name;
      try {
        if (info) title = String((JSON.parse(await info.file.text()) as { name?: string }).name || name);
      } catch {
        // keeps the folder's name
      }
      items.push({ kind: "practice", id: name, name: title, bytes: files.reduce((sum, f) => sum + f.file.size, 0), removable: true });
    }
  const models = await top?.getDirectoryHandle("models").catch(() => undefined);
  if (models) {
    const bytes = (await walk(models)).reduce((sum, f) => sum + f.file.size, 0);
    if (bytes) items.push({ kind: "model", id: "models", name: "Stem splitter model (downloads again when needed)", bytes, removable: true });
  }

  let used: number | undefined, quota: number | undefined, persisted = false;
  try {
    const estimate = await navigator.storage.estimate();
    used = estimate.usage;
    quota = estimate.quota;
    persisted = await navigator.storage.persisted();
  } catch {
    // not told
  }
  return { items, used, quota, persisted };
}

/** Forgets a Practice song or the model (tracks go through the app's Tracks, which shows them). */
export async function forgetFile(item: StoredItem): Promise<void> {
  const top = await root();
  if (!top) return;
  if (item.kind === "practice") await (await top.getDirectoryHandle("practice")).removeEntry(item.id, { recursive: true });
  else if (item.kind === "model") await top.removeEntry("models", { recursive: true });
}

/** Asks the browser not to clear these files when it runs short of space. */
export async function keepFiles(): Promise<boolean> {
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
