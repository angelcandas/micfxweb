// The sing-along tracks on the web: backing songs and recorded takes, kept in this browser
// (IndexedDB) so they are still there after a reload. The desktop keeps files in a folder;
// here a take is a WAV you can download. The audio plays in the worklet's Session.
import type { KeyEstimate } from "@micfx/engine";
import type { LiveAudio, RecordedTake } from "./audio";
import { compileEngine } from "./audio";
import KeyWorker from "./key-worker?worker";

const DB_NAME = "micfx-voice";
const STORE = "tracks";
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

  async addBackingTrack(file: Blob & { name?: string }): Promise<void> {
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
        gain: 1,
        muted: false,
        peaks: peaks(channels, rate),
        audio: file,
        fileName: file.name ?? `${name}.wav`,
      };
      this.decoded.set(track.id, { rate, channels });
      await this.add(track);
    } catch (error) {
      this.onError(`Couldn't load ${file.name ?? "the song"}: ${error instanceof Error ? error.message : String(error)}`);
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

  /** Downloads the last take (and its dry file). False when there is none. */
  downloadLastTake(): boolean {
    const take = this.lastTake ?? [...this.tracks].reverse().find((t) => t.isTake);
    if (!take) return false;
    download(take.audio, take.fileName);
    if (take.dry && take.dryFileName) download(take.dry, take.dryFileName);
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

function openDb(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE, { keyPath: "id" });
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

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function timestamp() {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`;
}
