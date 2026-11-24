// The sing-along tracks on the web: backing songs and recorded takes, kept in this browser
// (IndexedDB) so they are still there after a reload. The desktop keeps files in a folder;
// here a take is a WAV you can download. The audio plays in the worklet's Session.
import { takeFile, takeFormat } from "./take-format";
import type { KeyEstimate } from "@micfx/engine";
import type { LiveAudio, RecordedTake } from "./audio";
import { compileEngine } from "./audio";
import KeyWorker from "./key-worker?worker";
import type { SongFiles } from "./setlist";

const DB_NAME = "micfx-voice";
const STORE = "tracks";
const SONG_FILES = "songFiles"; // the setlist's backing tracks, by id
const PEAK_SECONDS = 0.02; // as the desktop's Multitrack
const MAX_MINUTES = 30;
const DECODE_RATE = 48000; // before the audio starts; decoded again at the device's rate

/** A track as kept in the browser. */
interface StoredTrack {
  id: number;
  name: string;
  isTake: boolean;
  /** Seconds on the timeline. */
  start: number;
  length: number;
  gain: number;
  muted: boolean;
  peaks: number[];
  /** The original file (a song) or the take as a WAV. */
  audio: Blob;
  fileName: string;
  /** The take's unprocessed mic, when "Dry" was on. */
  dry?: Blob;
  dryFileName?: string;
}

/** The desktop's getTracks() row. */
export interface TrackRow {
  id: number;
  name: string;
  file: string;
  isTake: boolean;
  start: number;
  length: number;
  gain: number;
  muted: boolean;
  peaks: number[];
  peakSeconds: number;
}

export class Tracks {
  onChanged: () => void = () => {};
  onError: (message: string) => void = () => {};
  /** Songs being decoded. */
  loading = 0;
  private tracks: StoredTrack[] = [];
  private decoded = new Map<number, { rate: number; channels: Float32Array[] }>();
  private db: Promise<IDBDatabase | undefined>;
  private lastTake: StoredTrack | undefined;

  constructor(private readonly audio: LiveAudio) {
    this.db = openDb();
  }

  /** Reads the tracks kept from the last visit. */
  async restore(): Promise<void> {
    const db = await this.db;
    if (!db) return;
    try {
      this.tracks = (await request<StoredTrack[]>(db.transaction(STORE).objectStore(STORE).getAll())).sort((a, b) => a.id - b.id);
    } catch {
      this.tracks = [];
    }
    if (this.tracks.length) this.onChanged();
  }

  rows(): TrackRow[] {
    return this.tracks.map((t) => ({
      id: t.id,
      name: t.name,
      file: t.fileName,
      isTake: t.isTake,
      start: t.start,
      length: t.length,
      gain: t.gain,
      muted: t.muted,
      peaks: t.peaks,
      peakSeconds: PEAK_SECONDS,
    }));
  }

  /** Seconds to the end of the last track. */
  get length(): number {
    return Math.max(0, ...this.tracks.map((t) => t.start + t.length));
  }

  /** Every track to the playing engine (after the audio starts, at its rate). */
  async pushAll(): Promise<void> {
    for (const track of this.tracks) await this.push(track);
  }

  /** Asks for a song file (a click), then loads it. False when nothing was picked. */
  pickBackingTrack(): Promise<boolean> {
    return new Promise((resolve) => {
      const input = Object.assign(document.createElement("input"), { type: "file", accept: "audio/*,.wav,.aif,.aiff,.flac,.ogg,.mp3,.m4a" });
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        resolve(Boolean(file));
        if (file) void this.addBackingTrack(file);
      });
      input.addEventListener("cancel", () => resolve(false));
      input.click();
    });
  }

  /** Loads a song file as a track; its id, or undefined when it couldn't be loaded. */
  async addBackingTrack(file: Blob & { name?: string }, options: { gain?: number; muted?: boolean } = {}): Promise<number | undefined> {
    this.loading++;
    this.onChanged();
    try {
      const rate = this.audio.sampleRate ?? DECODE_RATE;
      const channels = await decode(file, rate);
      const length = channels[0]!.length / rate;
      if (length > MAX_MINUTES * 60) throw new Error(`Songs up to ${MAX_MINUTES} minutes can be loaded.`);
      const name = (file.name ?? "Backing track").replace(/\.[^.]+$/, "");
      const track: StoredTrack = {
        id: this.nextId(),
        name,
        isTake: false,
        start: 0,
        length,
        gain: options.gain ?? 1,
        muted: options.muted ?? false,
        peaks: peaks(channels, rate),
        audio: file,
        fileName: file.name ?? `${name}.wav`,
      };
      this.decoded.set(track.id, { rate, channels });
      await this.add(track);
      return track.id;
    } catch (error) {
      this.onError(`Couldn't load ${file.name ?? "the song"}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    } finally {
      this.loading--;
      this.onChanged();
    }
  }

  /** A finished take becomes a track at `start` seconds (already corrected for latency). */
  async addTake(take: RecordedTake, start: number): Promise<StoredTrack> {
    const name = `MicFX ${timestamp()}`;
    const track: StoredTrack = {
      id: this.nextId(),
      name,
      isTake: true,
      start: Math.max(0, start),
      length: take.seconds,
      gain: 1,
      muted: false,
      peaks: peaks(take.channels, take.sampleRate),
      audio: encodeWav(take.channels, take.sampleRate),
      fileName: `${name}.wav`,
      ...(take.dry ? { dry: encodeWav([take.dry], take.sampleRate), dryFileName: `${name} (dry).wav` } : {}),
    };
    this.decoded.set(track.id, { rate: take.sampleRate, channels: take.channels });
    await this.add(track);
    this.lastTake = track;
    return track;
  }

  set(id: number, options: { gain?: number; muted?: boolean }): void {
    const track = this.tracks.find((t) => t.id === id);
    if (!track) return;
    if (typeof options.gain === "number" && Number.isFinite(options.gain)) track.gain = Math.max(0, Math.min(4, options.gain));
    if (typeof options.muted === "boolean") track.muted = options.muted;
    this.audio.setTrack(id, { gain: track.gain, muted: track.muted });
    void this.save(track);
  }

  async remove(id: number): Promise<void> {
    this.tracks = this.tracks.filter((t) => t.id !== id);
    this.decoded.delete(id);
    if (this.lastTake?.id === id) this.lastTake = undefined;
    this.audio.removeTrack(id);
    const db = await this.db;
    if (db) await done(db.transaction(STORE, "readwrite").objectStore(STORE).delete(id)).catch(() => {});
    this.onChanged();
  }

  /**
   * The tracks for MicFX DAW (plan point 28): the takes and the song, each a WAV that starts
   * at the timeline's start (silence before a later track), so they line up at bar 1. Muted
   * tracks stay here, unless every track is muted.
   */
  async handoffTracks(rate = 48000): Promise<{ name: string; data: ArrayBuffer; role: "take" | "backing" }[]> {
    const audible = this.tracks.filter((t) => !t.muted);
    const out = [];
    for (const track of audible.length ? audible : this.tracks) {
      const role = track.isTake ? ("take" as const) : ("backing" as const);
      const base = track.fileName.replace(/\.[^.]+$/, "") || track.name;
      if (track.start < 1e-3 && /\.wav$/i.test(track.fileName)) {
        out.push({ name: `${base}.wav`, data: await track.audio.arrayBuffer(), role });
        continue;
      }
      const channels = await decodeChannels(track.audio, rate);
      const lead = Math.round(track.start * rate);
      const padded = channels.map((channel) => {
        const longer = new Float32Array(lead + channel.length);
        longer.set(channel, lead);
        return longer;
      });
      out.push({ name: `${base}.wav`, data: await encodeWav(padded, rate).arrayBuffer(), role });
    }
    return out;
  }

  /** The backing song playing now (the first track that isn't a take). */
  currentBacking(): { name: string; file: Blob } | undefined {
    const song = this.tracks.find((t) => !t.isTake);
    return song && { name: song.fileName, file: song.audio };
  }

  /**
   * A setlist song's backing track (or none) takes the place of the last one. The takes
   * stay (they are only in this browser) but go quiet, as they belonged to the last song.
   */
  async replaceBacking(file: (Blob & { name: string }) | undefined): Promise<void> {
    for (const song of this.tracks.filter((t) => !t.isTake)) await this.remove(song.id);
    for (const take of this.tracks) if (!take.muted) this.set(take.id, { muted: true });
    if (file) await this.addBackingTrack(file);
    else this.onChanged();
  }

  /**
   * Downloads the last take (and its dry file) in the format picked in Settings. False when
   * there is none.
   */
  downloadLastTake(): boolean {
    const take = this.lastTake ?? [...this.tracks].reverse().find((t) => t.isTake);
    if (!take) return false;
    const format = takeFormat();
    const save = async (wav: Blob, fileName: string, cached?: { rate: number; channels: Float32Array[] }) => {
      const name = fileName.replace(/\.wav$/i, "");
      if (format === "wav") return download(wav, fileName);
      const rate = cached?.rate ?? (await wavRate(wav));
      const channels = cached?.channels ?? (await decode(wav, rate));
      const file = await takeFile(wav, channels, rate, name, format);
      download(file.blob, file.fileName);
    };
    void (async () => {
      try {
        await save(take.audio, take.fileName, await this.channels(take, await wavRate(take.audio)));
        if (take.dry && take.dryFileName) await save(take.dry, take.dryFileName);
      } catch (error) {
        this.onError(`Couldn't make the ${format.toUpperCase()} file (${error instanceof Error ? error.message : String(error)}), so here is the WAV.`);
        download(take.audio, take.fileName);
      }
    })();
    return true;
  }

  /** The first song's key, found in a worker. */
  async detectBackingKey(): Promise<(KeyEstimate & { track: string }) | { ok: false; error: string }> {
    const song = this.tracks.find((t) => !t.isTake);
    if (!song) return { ok: false, error: "Load a backing track first." };
    const { rate, channels } = await this.channels(song);
    const mono = new Float32Array(channels[0]!.length);
    for (const channel of channels) for (let i = 0; i < mono.length; ++i) mono[i]! += channel[i]! / channels.length;

    const module = await compileEngine();
    const worker = new KeyWorker();
    try {
      const result = await new Promise<KeyEstimate | { ok: false; error: string }>((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.onerror = (event) => reject(new Error(event.message));
        worker.postMessage({ module, mono, sampleRate: rate }, [mono.buffer]);
      });
      if (!result.ok) return { ok: false, error: "error" in result ? result.error : "No clear key in the backing track." };
      return { ...result, track: song.name };
    } finally {
      worker.terminate();
    }
  }

  private async add(track: StoredTrack) {
    this.tracks.push(track);
    await this.push(track);
    await this.save(track);
    this.onChanged();
  }

  private async push(track: StoredTrack) {
    const rate = this.audio.sampleRate;
    if (!rate) return;
    try {
      const { channels } = await this.channels(track, rate);
      // A copy: the page keeps its own for key detection and the next start.
      this.audio.addTrack(track.id, channels.map((c) => c.slice()), track.start, { gain: track.gain, muted: track.muted });
    } catch (error) {
      this.onError(`Couldn't play ${track.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The decoded audio, at `rate` when given (decoding again if it was another rate). */
  private async channels(track: StoredTrack, rate?: number) {
    const cached = this.decoded.get(track.id);
    if (cached && (rate === undefined || cached.rate === rate)) return cached;
    const at = rate ?? DECODE_RATE;
    const entry = { rate: at, channels: await decode(track.audio, at) };
    this.decoded.set(track.id, entry);
    return entry;
  }

  private async save(track: StoredTrack) {
    const db = await this.db;
    if (!db) return;
    try {
      await done(db.transaction(STORE, "readwrite").objectStore(STORE).put(track));
    } catch {
      this.onError("This browser has no room left to keep the track: it plays until you reload.");
    }
  }

  private nextId() {
    return Math.max(0, ...this.tracks.map((t) => t.id)) + 1;
  }
}

/** The setlist's song files, kept in the same database. */
export function songFiles(): SongFiles {
  const db = openDb();
  const store = async (mode: IDBTransactionMode) => (await db)?.transaction(SONG_FILES, mode).objectStore(SONG_FILES);
  return {
    async put(id, file) {
      const s = await store("readwrite");
      if (s) await done(s.put(file, id));
    },
    async get(id) {
      const s = await store("readonly");
      return s ? ((await request(s.get(id))) as Blob | undefined) : undefined;
    },
    async prune(keep) {
      const s = await store("readwrite");
      if (!s) return;
      for (const key of await request(s.getAllKeys())) if (!keep.has(String(key))) s.delete(key);
    },
  };
}

function openDb(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(DB_NAME, 2);
      open.onupgradeneeded = () => {
        const names = open.result.objectStoreNames;
        if (!names.contains(STORE)) open.result.createObjectStore(STORE, { keyPath: "id" });
        if (!names.contains(SONG_FILES)) open.result.createObjectStore(SONG_FILES);
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined); // private mode or blocked: tracks just aren't kept
    }
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(req: IDBRequest): Promise<void> {
  return request(req).then(() => undefined);
}

/** A file's audio at `rate`: one or two channels. */
export function decodeChannels(file: Blob, rate: number): Promise<Float32Array[]> {
  return decode(file, rate);
}

/** Decodes a file to one or two channels at `rate`. */
async function decode(file: Blob, rate: number): Promise<Float32Array[]> {
  const context = new OfflineAudioContext(1, 1, rate);
  const buffer = await context.decodeAudioData(await file.arrayBuffer());
  const channels: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); ++c) channels.push(buffer.getChannelData(c).slice());
  if (!channels.length || !channels[0]!.length) throw new Error("the file has no audio");
  return channels;
}

/** Max |sample| every PEAK_SECONDS, for the waveforms. */
function peaks(channels: Float32Array[], rate: number): number[] {
  const step = Math.max(1, Math.round(PEAK_SECONDS * rate));
  const frames = channels[0]?.length ?? 0;
  const out: number[] = [];
  for (let i = 0; i < frames; i += step) {
    let peak = 0;
    const end = Math.min(frames, i + step);
    for (const channel of channels) for (let j = i; j < end; ++j) peak = Math.max(peak, Math.abs(channel[j]!));
    out.push(Math.round(peak * 1000) / 1000);
  }
  return out;
}

/** A WAV's sample rate, from its header (44.1 kHz when it can't tell). */
async function wavRate(wav: Blob): Promise<number> {
  const head = new DataView(await wav.slice(0, 28).arrayBuffer());
  const rate = head.byteLength >= 28 ? head.getUint32(24, true) : 0;
  return rate >= 8000 && rate <= 192000 ? rate : 44100;
}

/** 24-bit PCM WAV. */
export function encodeWav(channels: Float32Array[], rate: number): Blob {
  const frames = channels[0]?.length ?? 0;
  const count = channels.length;
  const bytes = frames * count * 3;
  const view = new DataView(new ArrayBuffer(44 + bytes));
  const text = (at: number, value: string) => [...value].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, count, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * count * 3, true);
  view.setUint16(32, count * 3, true);
  view.setUint16(34, 24, true);
  text(36, "data");
  view.setUint32(40, bytes, true);
  let at = 44;
  for (let i = 0; i < frames; ++i) {
    for (const channel of channels) {
      const value = Math.round(Math.max(-1, Math.min(1, channel[i]!)) * 8388607);
      view.setUint8(at, value & 0xff);
      view.setUint8(at + 1, (value >> 8) & 0xff);
      view.setUint8(at + 2, (value >> 16) & 0xff);
      at += 3;
    }
  }
  return new Blob([view.buffer], { type: "audio/wav" });
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function timestamp() {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
}
