// Practice on the web: the desktop's Practice view (src/Practice.cpp). Open a song, sing
// along to it, and see how close you get.
//
// A song is prepared once: its melody is found in the voice (analysis.wasm in a Worker)
// and kept, with the audio, in this browser's private files (OPFS) under practice/<id>/,
// so the library opens it again at once. It plays on the Live tracks; the worklet's pitch
// tap (the mic before the effects) is scored against it by the desktop's scoring
// (analysis.wasm on the page), and the page hears back on the desktop's events.
import type { PracticeScores, PracticeSong } from "@micfx/engine/analysis";

/** How the analysis on the page scores (Analysis from @micfx/engine/analysis). */
export interface PracticeScorer {
  scoreSong(melody: string): PracticeSong;
  scoreFrames(frames: Float64Array, songTime: number): void;
  scoreRestart(songTime: number): void;
  scoreTime(songTime: number): void;
  scoreChanges(all?: boolean): PracticeScores | undefined;
  scoreReport(): Record<string, unknown>;
}

/** A song's folder of files. */
export interface PracticeStore {
  folders(): Promise<string[]>;
  read(folder: string, name: string): Promise<Blob | undefined>;
  write(folder: string, name: string, data: Blob | string): Promise<void>;
  remove(folder: string): Promise<void>;
}

export interface PracticeHost {
  store: PracticeStore;
  scorer(): Promise<PracticeScorer>;
  /** The song's audio at `rate`: one or two channels. */
  decode(file: Blob, rate: number): Promise<Float32Array[]>;
  /** The voice and the rest of a stereo song at 44.1 kHz (the stem splitter). Throws an AbortError when cancelled. */
  split(song: [Float32Array, Float32Array], report: (phase: "downloading" | "loading" | "splitting", progress: number) => void, cancelled: () => boolean): Promise<{ voice: [Float32Array, Float32Array]; backing: [Float32Array, Float32Array] }>;
  encodeWav(channels: Float32Array[], rate: number): Blob;
  findMelody(voice: Float32Array, rate: number, keyAudio?: Float32Array): Promise<{ melody: string; key: string }>;
  pickFile(accept: string): Promise<File | undefined>;
  /** The song on the Live tracks in place of what was there; the guide's track id. */
  install(guide: File, backing: File | undefined, guideLevel: number): Promise<number | undefined>;
  /** The guide track's level (muted at 0). */
  setGuide(id: number, level: number): void;
  /** The Live track ids there are now. */
  trackIds(): number[];
  /** Back to the start, stopped. */
  restart(): void;
  pitch(on: boolean): void;
  /** Mic in to speaker out, in seconds. */
  latency(): number;
  emit(name: string, payload: unknown): void;
  load(): string | null;
  save(value: string): void;
  now?(): number;
}

interface Info {
  name: string;
  key: string;
  seconds: number;
  voiceOnly: boolean;
  opened: number;
  guide: string;
  backing: string;
}

type Phase = "reading" | "downloading" | "loading" | "splitting" | "listening";
const AUDIO = "audio/*,.wav,.aif,.aiff,.flac,.ogg,.mp3,.m4a";
const RATE = 44100; // the desktop's (the stem model's)
const MELODY = "melody.txt";
const GUIDE = "guide.wav";
const BACKING = "backing.wav";
const INFO = "info.json";
const SAVED_KEY_LEVEL = "guideLevel";

interface Job {
  phase: Phase;
  progress: number;
  name: string;
  cancelled: boolean;
}

interface Current {
  folder: string;
  info: Info;
  melody: string;
  song: PracticeSong;
  guideId: number | undefined;
}

export class Practice {
  private job: Job | undefined;
  private current: Current | undefined;
  private guideLevel = 0.35;
  private viewOpen = false;
  private lastPosition = -1;
  private lastSongTime = 0;
  private wasPlaying = false;
  private scorer: PracticeScorer | undefined;

  constructor(private readonly host: PracticeHost) {
    try {
      const saved = JSON.parse(host.load() ?? "null") as { guideLevel?: number } | null;
      if (typeof saved?.[SAVED_KEY_LEVEL] === "number") this.guideLevel = Math.min(1.5, Math.max(0, saved.guideLevel));
    } catch {
      // the defaults
    }
  }

  /** The song from the last visit, when its guide is still on the Live tracks. */
  async restore(): Promise<void> {
    try {
      const saved = JSON.parse(this.host.load() ?? "null") as { folder?: string; guideId?: number } | null;
      if (!saved?.folder || typeof saved.guideId !== "number" || !this.host.trackIds().includes(saved.guideId)) return;
      const loaded = await this.loadFolder(saved.folder);
      if (!loaded || this.current) return;
      await this.setCurrent(saved.folder, loaded.info, loaded.melody, saved.guideId);
      this.host.emit("practice", { state: "ready", song: this.describeSong(), fromCache: true, quiet: true });
    } catch {
      // nothing to pick up
    }
  }

  /** The page's "practice" native function. */
  async handle(action: string, options: Record<string, unknown> = {}): Promise<unknown> {
    switch (action) {
      case "open": {
        const split = options.split !== false;
        const file = await this.host.pickFile(AUDIO);
        if (file) void this.prepare(file, split);
        return { ok: true };
      }
      case "library":
        return this.library();
      case "openCached": {
        const folder = String(options.id ?? "");
        const loaded = await this.loadFolder(folder);
        if (!loaded) {
          const error = "That song isn't in the library any more.";
          this.host.emit("practice", { state: "error", error });
          return { ok: false, error };
        }
        if (this.job) this.job.cancelled = true;
        this.job = undefined;
        const error = await this.install(folder, loaded.info, loaded.melody);
        if (error) {
          this.host.emit("practice", { state: "error", error });
          return { ok: false, error };
        }
        this.host.emit("practice", { state: "ready", song: this.describeSong(), fromCache: true });
        return { ok: true };
      }
      case "forget": {
        const folder = String(options.id ?? "");
        if (folder && folder !== this.current?.folder) await this.host.store.remove(folder).catch(() => {});
        return { ok: true };
      }
      case "cancel":
        if (this.job) this.job.cancelled = true;
        break;
      case "view":
        this.viewOpen = Boolean(options.open);
        this.host.pitch(this.viewOpen);
        break;
      case "guide": {
        const level = Number(options.level);
        if (Number.isFinite(level)) this.guideLevel = Math.min(1.5, Math.max(0, level));
        if (this.current?.guideId !== undefined) this.host.setGuide(this.current.guideId, this.guideLevel);
        this.persist();
        break;
      }
      case "reset":
        this.restartFrom(0);
        this.host.restart();
        this.lastPosition = 0;
        break;
      case "report":
        return this.scorer && this.current ? this.scorer.scoreReport() : null;
      case "lyrics":
      case "alignLyrics":
      case "nudgeLyric":
        return [];
      case "sections":
        this.host.emit("practice", { state: "sections", sections: [], error: "Finding a song's sections is coming to the web soon." });
        break;
      case "loop":
      case "speed":
        this.host.emit("practice", { state: "error", error: "Loops and key or speed changes are coming to the web soon." });
        break;
    }
    return this.describe();
  }

  describe() {
    return {
      song: this.describeSong(),
      job: this.describeJob(),
      guideLevel: this.guideLevel,
      open: this.viewOpen,
      scores: this.current && this.scorer ? this.scorer.scoreChanges(true) : null,
    };
  }

  /**
   * About 30 times a second with the worklet's meters: the pitch readings ([position in
   * samples, midi, level dB] each) and where the song is.
   */
  tick(pitch: Float64Array | undefined, transport: { position: number; playing: boolean }, sampleRate: number): void {
    if (!this.viewOpen) return;
    const latency = this.host.latency();
    const position = transport.position;
    const playing = transport.playing;
    const songTime = Math.max(0, position - latency);
    const scorer = this.current ? this.scorer : undefined;

    // A jump (a seek, a restart) starts the part after it over.
    if (this.lastPosition >= 0 && (position < this.lastPosition - 0.05 || position > this.lastPosition + 0.75)) this.restartFrom(songTime);
    this.lastPosition = position;

    // The song stopped after some singing: the report for the pass.
    if (this.wasPlaying && !playing && scorer && scorer.scoreChanges(true)?.phrases.some((p) => p.scored))
      this.host.emit("practiceReport", scorer.scoreReport());
    this.wasPlaying = playing;

    const frames: number[] = [];
    let lastMidi = 0;
    for (let i = 0; pitch && i + 2 < pitch.length; i += 3) {
      const time = pitch[i]! / sampleRate - latency;
      lastMidi = pitch[i + 2]! > -60 ? pitch[i + 1]! : 0;
      // (readings from before a jump, still on their way, are left out)
      if (playing && time >= this.lastSongTime - 0.5 && time <= songTime + 0.1) frames.push(round3(time), round2(lastMidi));
    }

    if (scorer && playing) scorer.scoreFrames(Float64Array.from(frames), songTime);
    else scorer?.scoreTime(songTime);
    this.lastSongTime = songTime;

    const changes = scorer?.scoreChanges(false);
    if (changes) this.host.emit("practiceScore", changes);
    this.host.emit("practicePitch", { time: round3(songTime), playing, midi: round2(lastMidi), frames });
  }

  //==============================================================================
  private async prepare(file: File, split: boolean) {
    if (this.job) this.job.cancelled = true;
    const job: Job = { phase: "reading", progress: 0, name: file.name.replace(/\.[^.]+$/, ""), cancelled: false };
    this.job = job;
    const report = () => this.host.emit("practice", { state: "preparing", job: this.describeJob() });
    const fail = (error: string) => {
      if (this.job === job) this.job = undefined;
      this.host.emit("practice", job.cancelled ? { state: "cancelled" } : { state: "error", error });
    };
    report();

    try {
      const folder = `${await fileId(file)}${split ? "" : "-voice"}`;
      const cached = await this.loadFolder(folder);
      if (job.cancelled) return fail("");
      if (cached) {
        const error = await this.install(folder, cached.info, cached.melody);
        if (this.job === job) this.job = undefined;
        if (error) return fail(error);
        this.host.emit("practice", { state: "ready", song: this.describeSong(), fromCache: true });
        return;
      }

      const decoded = await this.host.decode(file, RATE);
      if (job.cancelled) return fail("");
      const seconds = decoded[0]!.length / RATE;
      let voice = mono(decoded);
      let keyAudio: Float32Array | undefined;
      let guideFile: Blob = file;
      let backingFile: Blob | undefined;

      if (split) {
        const stereo: [Float32Array, Float32Array] = [decoded[0]!, decoded[1] ?? decoded[0]!];
        let lastReport = 0;
        const parts = await this.host.split(
          stereo,
          (phase, progress) => {
            job.phase = phase;
            job.progress = progress;
            const now = this.now();
            if (now - lastReport > 250 || progress === 0) report();
            lastReport = now;
          },
          () => job.cancelled,
        );
        if (job.cancelled) return fail("");
        voice = mono(parts.voice);
        keyAudio = mono(parts.backing);
        guideFile = this.host.encodeWav(parts.voice, RATE);
        backingFile = this.host.encodeWav(parts.backing, RATE);
      }

      job.phase = "listening";
      job.progress = 0.5;
      report();
      const { melody, key } = await this.host.findMelody(voice, RATE, keyAudio);
      if (job.cancelled) return fail("");
      if (!melody.trim()) return fail(split ? "Couldn't find a sung melody in this song." : "Couldn't find a sung melody in this file.");

      const guideName = split ? GUIDE : file.name;
      const info: Info = { name: job.name, key, seconds: round3(seconds), voiceOnly: !split, opened: this.now(), guide: guideName, backing: backingFile ? BACKING : "" };
      await this.host.store.write(folder, guideName, guideFile);
      if (backingFile) await this.host.store.write(folder, BACKING, backingFile);
      await this.host.store.write(folder, MELODY, melody);
      await this.host.store.write(folder, INFO, JSON.stringify(info));
      if (job.cancelled) return fail("");
      const error = await this.install(folder, info, melody);
      if (this.job === job) this.job = undefined;
      if (error) return fail(error);
      this.host.emit("practice", { state: "ready", song: this.describeSong(), fromCache: false });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") job.cancelled = true;
      const message = error instanceof Error ? error.message : String(error);
      fail(/quota/i.test(message) ? "This browser has no room left to keep the song." : `Couldn't prepare ${file.name}: ${message}`);
    }
  }

  private async install(folder: string, info: Info, melody: string): Promise<string> {
    const guideBlob = await this.host.store.read(folder, info.guide);
    const backingBlob = info.backing ? await this.host.store.read(folder, info.backing) : undefined;
    if (!guideBlob || (info.backing && !backingBlob)) return "This song's saved files are incomplete. Open the song again.";
    const guide = new File([guideBlob], info.guide);
    const backing = backingBlob && new File([backingBlob], info.backing);
    const guideId = await this.host.install(guide, backing, this.guideLevel);
    info.opened = this.now();
    await this.host.store.write(folder, INFO, JSON.stringify(info)).catch(() => {});
    await this.setCurrent(folder, info, melody, guideId);
    return "";
  }

  private async setCurrent(folder: string, info: Info, melody: string, guideId: number | undefined) {
    this.scorer ??= await this.host.scorer();
    const song = this.scorer.scoreSong(melody);
    this.current = { folder, info, melody, song, guideId };
    this.lastPosition = -1;
    this.lastSongTime = 0;
    this.persist();
  }

  private restartFrom(songTime: number) {
    if (this.current) this.scorer?.scoreRestart(songTime);
    this.lastSongTime = songTime;
  }

  private async loadFolder(folder: string): Promise<{ info: Info; melody: string } | undefined> {
    if (!/^[0-9a-f]{20}(-voice)?$/.test(folder)) return undefined;
    const [infoBlob, melodyBlob] = await Promise.all([this.host.store.read(folder, INFO), this.host.store.read(folder, MELODY)]);
    if (!infoBlob || !melodyBlob) return undefined;
    const info = JSON.parse(await infoBlob.text()) as Info;
    const melody = await melodyBlob.text();
    return info.name && melody.trim() ? { info, melody } : undefined;
  }

  private async library() {
    const entries = [];
    for (const folder of await this.host.store.folders().catch(() => [])) {
      const loaded = await this.loadFolder(folder).catch(() => undefined);
      if (!loaded) continue;
      const { info } = loaded;
      entries.push({
        id: folder,
        name: info.name,
        key: info.key,
        seconds: info.seconds,
        voiceOnly: info.voiceOnly,
        opened: info.opened,
        current: folder === this.current?.folder,
      });
    }
    return entries.sort((a, b) => b.opened - a.opened);
  }

  private describeSong() {
    const current = this.current;
    if (!current) return null;
    return {
      name: current.info.name,
      file: current.info.guide,
      ...current.song,
      hasBacking: Boolean(current.info.backing),
      key: current.info.key,
      shift: { speed: 1, semitones: 0, pending: false, target: null, progress: 1 },
      lyrics: [],
      sections: null,
      loop: null,
    };
  }

  private describeJob() {
    const job = this.job;
    return job ? { phase: job.phase, progress: round3(job.progress), name: job.name } : null;
  }

  private persist() {
    this.host.save(JSON.stringify({ guideLevel: this.guideLevel, folder: this.current?.folder ?? "", guideId: this.current?.guideId ?? -1 }));
  }

  private now() {
    return this.host.now?.() ?? Date.now();
  }
}

/** One or two channels to one. */
function mono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!;
  const out = new Float32Array(channels[0]!.length);
  for (const channel of channels) for (let i = 0; i < out.length; ++i) out[i]! += channel[i]! / channels.length;
  return out;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const round2 = (value: number) => Math.round(value * 100) / 100;

/** The desktop's cache id: the first 20 hex digits of the file's SHA-256. */
export async function fileId(file: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  return Array.from(digest.slice(0, 10), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The songs' folders in this browser's private files (OPFS), under practice/. */
export function opfsStore(): PracticeStore {
  const root = async () => {
    if (!navigator.storage?.getDirectory) throw new Error("this browser can't keep files");
    void navigator.storage.persist?.().catch(() => false); // ask once to keep them
    return (await navigator.storage.getDirectory()).getDirectoryHandle("practice", { create: true });
  };
  const legal = (name: string) => name.replace(/[\\/:*?"<>|\0]/g, "_").slice(0, 200) || "file";
  return {
    async folders() {
      const names: string[] = [];
      for await (const [name, handle] of (await root()) as unknown as AsyncIterable<[string, FileSystemHandle]>) if (handle.kind === "directory") names.push(name);
      return names;
    },
    async read(folder, name) {
      try {
        const dir = await (await root()).getDirectoryHandle(folder);
        return await (await dir.getFileHandle(legal(name))).getFile();
      } catch {
        return undefined;
      }
    },
    async write(folder, name, data) {
      const dir = await (await root()).getDirectoryHandle(folder, { create: true });
      const writable = await (await dir.getFileHandle(legal(name), { create: true })).createWritable();
      try {
        await writable.write(data);
      } finally {
        await writable.close();
      }
    },
    async remove(folder) {
      await (await root()).removeEntry(folder, { recursive: true });
    },
  };
}
