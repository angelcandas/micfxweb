// Practice on the web: the desktop's Practice view (src/Practice.cpp). Open a song, sing
// along to it, and see how close you get.
//
// A song is prepared once: its melody is found in the voice (analysis.wasm in a Worker)
// and kept, with the audio, in this browser's private files (OPFS) under practice/<id>/,
// so the library opens it again at once. It plays on the Live tracks; the worklet's pitch
// tap (the mic before the effects) is scored against it by the desktop's scoring
// (analysis.wasm on the page), and the page hears back on the desktop's events.
import type { PracticeLyrics, PracticeScores, PracticeSong, SongSection } from "@micfx/engine/analysis";
import { historyFile, partMelody, type Part } from "./harmony";
import { addPass, parsePasses, passFrom, type Pass } from "./practice-history";

/** How the analysis on the page scores (Analysis from @micfx/engine/analysis). */
export interface PracticeScorer {
  scoreSong(melody: string): PracticeSong;
  scoreFrames(frames: Float64Array, songTime: number): void;
  scoreRestart(songTime: number): void;
  scoreTime(songTime: number): void;
  scoreChanges(all?: boolean): PracticeScores | undefined;
  scoreReport(): Record<string, unknown>;
  lyricsSet(text: string, kept?: boolean): PracticeLyrics;
  lyricsAlign(all: boolean): PracticeLyrics;
  lyricsNudge(index: number, seconds: number): PracticeLyrics;
  scoreShift(semitones: number, speed: number, songTime: number): PracticeSong;
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
  download(blob: Blob, name: string): void;
  /** The song on the Live tracks in place of what was there; the guide's track id. */
  install(guide: File, backing: File | undefined, guideLevel: number): Promise<number | undefined>;
  /** The guide track's level (muted at 0). */
  setGuide(id: number, level: number): void;
  /** The Live track ids there are now. */
  trackIds(): number[];
  /** Back to the start, stopped. */
  restart(): void;
  /** Moves the playhead (seconds), playing on when `play`. */
  seek(seconds: number, play: boolean): void;
  /** Loops from..to seconds on the Live tracks; none ends it. */
  loop(from?: number, to?: number): void;
  /** The song's sections, from its audio (mono). */
  sections(mono: Float32Array, rate: number): Promise<SongSection[]>;
  /** The audio `speed` times as fast and moved by `semitones` (`voice`: a voice's formants kept). */
  warp(channels: Float32Array[], rate: number, speed: number, semitones: number, voice: boolean): Promise<Float32Array[]>;
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
const LYRICS = "lyrics.txt";
const BACKING = "backing.wav";
const INFO = "info.json";
const SECTIONS = "sections.json";
const LOOP_LEAD_IN = 1.5; // seconds before a looped phrase or section
const LOOP_TAIL = 0.6; // and after it
const SAVED_KEY_LEVEL = "guideLevel";

interface Job {
  phase: Phase;
  progress: number;
  name: string;
  cancelled: boolean;
  /** The song's length and when splitting began (ms), for the time left. */
  seconds?: number;
  splitFrom?: number;
}

const SPLIT_SPEED_KEY = "micfx.splitSpeed";

/** Seconds of song split per second here, from the last split (undefined before the first). */
function splitSpeed(): number | undefined {
  try {
    const value = Number(localStorage.getItem(SPLIT_SPEED_KEY));
    return value > 0 && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Seconds left of a split: from how far it has got once it's under way, else from how fast
 * the last split went here, else a guess from the cores (about a fifth of real time each, at
 * most two splitters).
 */
export function splitSecondsLeft(job: { seconds: number; progress: number; elapsed: number }, speed = splitSpeed(), cores = navigator.hardwareConcurrency || 2): number {
  if (job.progress > 0.04 && job.elapsed > 2) return (job.elapsed * (1 - job.progress)) / job.progress;
  const rate = speed ?? 0.2 * Math.min(2, Math.max(1, Math.floor(cores / 4)));
  return Math.max(0, job.seconds / rate - job.elapsed);
}

interface Current {
  folder: string;
  info: Info;
  melody: string;
  song: PracticeSong;
  guideId: number | undefined;
  lyrics: PracticeLyrics["lines"];
  /** The melody as it is (song: as it plays, in another key or speed). */
  base: PracticeSong;
  sections: SongSection[] | "finding" | null;
}

interface Shift {
  speed: number;
  semitones: number;
}

interface Loop extends Shift {
  phrase: number;
  lastPhrase: number;
  section: number;
  /** In the song as it is, seconds. */
  from: number;
  to: number;
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
  private lastLrc = "";
  private shift: Shift = { speed: 1, semitones: 0 };
  private pending: (Shift & { progress: number }) | undefined;
  private shiftToken = 0;
  private loopState: Loop | undefined;
  private playing = false;
  /** This song's whole passes, oldest first. */
  private passes: Pass[] = [];
  /** What you sang this pass: [song time, midi] pairs, for the result card. */
  private trail: number[] = [];
  /** The part sung: the melody, or a harmony a third above or below it (duet mode). */
  private part: Part = "lead";
  /** Who hears each pitch reading (the range finder): MIDI, 0 where none. */
  private pitchListeners = new Set<(midi: number) => void>();

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
      const saved = JSON.parse(this.host.load() ?? "null") as { folder?: string; guideId?: number; shift?: Shift; part?: Part } | null;
      if (!saved?.folder || typeof saved.guideId !== "number" || !this.host.trackIds().includes(saved.guideId)) return;
      const loaded = await this.loadFolder(saved.folder);
      if (!loaded || this.current) return;
      await this.setCurrent(saved.folder, loaded.info, loaded.melody, saved.guideId, saved.part === "above" || saved.part === "below" ? saved.part : "lead");
      // The tracks are the song in the key and speed it had.
      const current = this.current as Current | undefined; // (set by setCurrent)
      if (saved.shift && Number.isFinite(saved.shift.speed) && Number.isFinite(saved.shift.semitones) && current) {
        this.shift = { speed: saved.shift.speed, semitones: saved.shift.semitones };
        current.song = this.scorer!.scoreShift(this.shift.semitones, this.shift.speed, 0);
      }
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
        if (this.pending) {
          // A key or speed change not heard yet: stay as we are.
          this.pending = undefined;
          this.shiftToken++;
          this.host.emit("practice", { state: "shifting", shift: this.describeShift() });
        }
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
        return this.setLyrics(this.scorer && this.current ? this.scorer.lyricsSet(String(options.text ?? "")) : undefined, false);
      case "importLyrics": {
        if (!this.current) return { ok: false };
        const file = await this.host.pickFile(".lrc,.txt,text/plain");
        if (!file) return { ok: false };
        if (file.size > 1024 * 1024) {
          this.host.emit("practice", { state: "error", error: `${file.name} is too big for lyrics.` });
          return { ok: false };
        }
        this.setLyrics(this.scorer!.lyricsSet(await file.text()), true);
        return { ok: true };
      }
      case "exportLyrics": {
        const lrc = this.current && this.scorer ? this.lastLrc : "";
        if (!lrc) return { ok: false };
        this.host.download(new Blob([lrc], { type: "text/plain" }), `${this.current!.info.name}.lrc`);
        return { ok: true };
      }
      case "alignLyrics":
        return this.setLyrics(this.scorer && this.current ? this.scorer.lyricsAlign(Boolean(options.all)) : undefined, false);
      case "nudgeLyric": {
        const index = Number(options.line);
        const line = this.current?.lyrics[index];
        if (!line || !this.scorer) return this.describeLyrics();
        // (`at` and `by` are in the song as it plays: a second at 50% speed is half a second of it)
        const by = typeof options.at === "number" ? options.at * this.shift.speed - line.start : (Number(options.by) || 0) * this.shift.speed;
        return this.setLyrics(this.scorer.lyricsNudge(index, by), false);
      }
      case "sections":
        void this.findSections();
        break;
      case "speed":
        await this.startShift(Number(options.speed ?? 1), Number(options.semitones ?? 0));
        break;
      case "loop":
        await this.startLoop(options);
        break;
      case "unloop":
        if (this.loopState) {
          this.loopState = undefined;
          this.host.loop();
        }
        this.host.emit("practice", { state: "ready", song: this.describeSong(), fromCache: true, quiet: true });
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
    this.playing = playing;
    const songTime = Math.max(0, position - latency);
    const scorer = this.current ? this.scorer : undefined;

    // A jump (a seek, a restart) starts the part after it over.
    if (this.lastPosition >= 0 && (position < this.lastPosition - 0.05 || position > this.lastPosition + 0.75)) this.restartFrom(songTime);
    this.lastPosition = position;

    // The song stopped after some singing: the report for the pass.
    if (this.wasPlaying && !playing && scorer && scorer.scoreChanges(true)?.phrases.some((p) => p.scored)) {
      const report = scorer.scoreReport();
      this.recordPass(report);
      this.host.emit("practiceReport", report);
    }
    this.wasPlaying = playing;

    const frames: number[] = [];
    let lastMidi = 0;
    for (let i = 0; pitch && i + 2 < pitch.length; i += 3) {
      const time = pitch[i]! / sampleRate - latency;
      lastMidi = pitch[i + 2]! > -60 ? pitch[i + 1]! : 0;
      for (const listener of this.pitchListeners) listener(lastMidi);
      // (readings from before a jump, still on their way, are left out)
      if (playing && time >= this.lastSongTime - 0.5 && time <= songTime + 0.1) {
        frames.push(round3(time), round2(lastMidi));
        if (lastMidi > 0 && !this.loopState && time > (this.trail.at(-2) ?? -1) + 0.04 && this.trail.length < 60000) this.trail.push(round3(time), round2(lastMidi));
      }
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
        job.seconds = seconds;
        const parts = await this.host.split(
          stereo,
          (phase, progress) => {
            if (phase === "splitting" && job.phase !== "splitting") job.splitFrom = this.now();
            job.phase = phase;
            job.progress = progress;
            const now = this.now();
            if (now - lastReport > 250 || progress === 0) report();
            lastReport = now;
          },
          () => job.cancelled,
        );
        if (job.cancelled) return fail("");
        if (job.splitFrom !== undefined && seconds > 20) {
          // How fast it went here, for the next song's estimate.
          try {
            localStorage.setItem(SPLIT_SPEED_KEY, String(seconds / Math.max(1, (this.now() - job.splitFrom) / 1000)));
          } catch {
            // not kept
          }
        }
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
    let files: { guide: File; backing?: File };
    try {
      files = await this.originalFiles({ folder, info });
    } catch {
      return "This song's saved files are incomplete. Open the song again.";
    }
    const { guide, backing } = files;
    const guideId = await this.host.install(guide, backing, this.guideLevel);
    info.opened = this.now();
    await this.host.store.write(folder, INFO, JSON.stringify(info)).catch(() => {});
    await this.setCurrent(folder, info, melody, guideId);
    return "";
  }

  /** New lyrics: kept in the song's folder, and to the page (as an event too when `announce`). */
  private setLyrics(lyrics: PracticeLyrics | undefined, announce: boolean) {
    if (!lyrics || !this.current) return [];
    this.current.lyrics = lyrics.lines;
    this.lastLrc = lyrics.lrc;
    void this.host.store.write(this.current.folder, LYRICS, lyrics.saved).catch(() => {});
    if (announce) this.host.emit("practice", { state: "lyrics", lyrics: this.describeLyrics() });
    return this.describeLyrics();
  }

  /** The lyrics in the song as it plays (moved for a speed change). */
  private describeLyrics() {
    const speed = this.shift.speed;
    return (this.current?.lyrics ?? []).map((line) => ({
      ...line,
      start: round3(line.start / speed),
      end: round3(line.end / speed),
      words: line.words.map((w, i) => (i % 2 ? round3((w as number) / speed) : w)),
    }));
  }

  //==============================================================================
  // Key and speed: the song rendered again (the DAW's Warp, in a Worker) and kept in its
  // folder, then swapped in where it was; the melody moves with it.
  private describeShift() {
    const pending = this.pending;
    return {
      speed: this.shift.speed,
      semitones: this.shift.semitones,
      pending: Boolean(pending),
      target: pending ? { speed: pending.speed, semitones: pending.semitones } : null,
      progress: pending ? round3(pending.progress) : 1,
    };
  }

  private async startShift(speedIn: number, semitonesIn: number) {
    const current = this.current;
    if (!current || !this.scorer) return;
    const speed = Math.round(Math.min(1.5, Math.max(0.5, Number.isFinite(speedIn) ? speedIn : 1)) * 1000) / 1000;
    const semitones = Math.round(Math.min(12, Math.max(-12, Number.isFinite(semitonesIn) ? semitonesIn : 0)) * 100) / 100;
    const token = ++this.shiftToken;
    if (Math.abs(speed - this.shift.speed) < 1e-3 && Math.abs(semitones - this.shift.semitones) < 5e-3) {
      this.pending = undefined;
      this.host.emit("practice", { state: "shifting", shift: this.describeShift() });
      return;
    }
    this.pending = { speed, semitones, progress: 0 };
    this.host.emit("practice", { state: "shifting", shift: this.describeShift() });

    let files: { guide: File; backing?: File };
    try {
      files = await this.versionFiles(current, speed, semitones, (progress) => {
        if (token !== this.shiftToken || !this.pending) return;
        this.pending.progress = progress;
        this.host.emit("practice", { state: "shifting", shift: this.describeShift() });
      });
    } catch (error) {
      if (token !== this.shiftToken) return;
      this.pending = undefined;
      this.host.emit("practice", { state: "error", error: `Couldn't change the key or speed: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    if (token !== this.shiftToken || this.current !== current) return; // a newer change, or cancelled

    // Swapped in where we are, in the song as it is.
    const original = Math.max(0, this.lastPosition) * this.shift.speed;
    const playing = this.playing;
    const guideId = await this.host.install(files.guide, files.backing, this.guideLevel);
    if (token !== this.shiftToken || this.current !== current) return;
    this.shift = { speed, semitones };
    this.pending = undefined;
    current.guideId = guideId;
    const position = original / speed;
    current.song = this.scorer.scoreShift(semitones, speed, position);
    if (this.loopState) this.applyLoop(false);
    this.host.seek(position, playing);
    this.lastPosition = position;
    this.lastSongTime = position;
    this.persist();
    this.host.emit("practice", { state: "ready", song: this.describeSong(), fromCache: true, quiet: true });
  }

  /** The guide and backing in a key and speed: the originals, kept ones, or rendered now. */
  private async versionFiles(current: Current, speed: number, semitones: number, progress: (p: number) => void): Promise<{ guide: File; backing?: File }> {
    const { folder, info } = current;
    const original = await this.originalFiles(current);
    if (Math.abs(speed - 1) < 1e-3 && Math.abs(semitones) < 5e-3) return original;
    const name = (part: string) => `shift-${speed.toFixed(3)}-${semitones.toFixed(2)}-${part}.wav`;
    // (what the Live tracks show: "Song (voice, +2 st, 75%).wav")
    const shown = (voice: boolean) => {
      const what = [voice ? "voice" : "backing", semitones ? `${semitones > 0 ? "+" : "−"}${Math.abs(semitones)} st` : "", speed !== 1 ? `${Math.round(speed * 100)}%` : ""];
      return `${info.name} (${what.filter(Boolean).join(", ")}).wav`;
    };
    const keptGuide = await this.host.store.read(folder, name("guide"));
    const keptBacking = info.backing ? await this.host.store.read(folder, name("backing")) : undefined;
    if (keptGuide && (!info.backing || keptBacking))
      return { guide: new File([keptGuide], shown(true)), backing: keptBacking && new File([keptBacking], shown(false)) };

    const parts = original.backing ? 2 : 1;
    const render = async (file: File, voice: boolean, index: number) => {
      progress(index / parts);
      const audio = await this.host.decode(file, RATE);
      const warped = await this.host.warp(audio, RATE, speed, semitones, voice);
      const blob = this.host.encodeWav(warped, RATE);
      await this.host.store.write(folder, name(voice ? "guide" : "backing"), blob).catch(() => {});
      return new File([blob], shown(voice));
    };
    const backing = original.backing ? await render(original.backing, false, 0) : undefined;
    const guide = await render(original.guide, true, parts - 1);
    progress(1);
    return { guide, backing };
  }

  private async originalFiles({ folder, info }: Pick<Current, "folder" | "info">): Promise<{ guide: File; backing?: File }> {
    const guide = await this.host.store.read(folder, info.guide);
    const backing = info.backing ? await this.host.store.read(folder, info.backing) : undefined;
    if (!guide || (info.backing && !backing)) throw new Error("this song's saved files are incomplete");
    // (a split song's stems show as "Song (voice).wav" and "Song (backing).wav")
    const guideName = info.backing ? `${info.name} (voice).wav` : info.guide;
    return { guide: new File([guide], guideName), backing: backing && new File([backing], `${info.name} (backing).wav`) };
  }

  //==============================================================================
  // Loops: a phrase or a section plays round and round (in the key and speed asked for).
  private async startLoop(options: Record<string, unknown>) {
    const current = this.current;
    if (!current) return;
    const phrases = current.base.phrases;
    const seconds = current.info.seconds;
    let range: Omit<Loop, keyof Shift> | undefined;
    if (typeof options.section === "number") {
      const section = Array.isArray(current.sections) ? current.sections[options.section] : undefined;
      if (!section) return;
      let first = -1;
      let last = -1;
      for (let i = 0; i * 2 < phrases.length; ++i) {
        const start = phrases[i * 2]!;
        if (start >= section.start - 0.25 && start < section.end - 0.25) {
          if (first < 0) first = i;
          last = i;
        }
      }
      range = { phrase: first, lastPhrase: last, section: options.section, from: Math.max(0, section.start - LOOP_LEAD_IN), to: Math.min(seconds || Infinity, section.end + LOOP_TAIL) };
    } else {
      const phrase = Number(options.phrase);
      if (!Number.isInteger(phrase) || phrase < 0 || phrase * 2 >= phrases.length) return;
      range = { phrase, lastPhrase: phrase, section: -1, from: Math.max(0, phrases[phrase * 2]! - LOOP_LEAD_IN), to: Math.min(seconds || Infinity, phrases[phrase * 2 + 1]! + LOOP_TAIL) };
    }
    const speed = Number(options.speed ?? this.shift.speed);
    const semitones = Number(options.semitones ?? this.shift.semitones);
    this.loopState = { ...range, speed, semitones };
    this.applyLoop(true);
    this.host.emit("practice", { state: "loop", song: this.describeSong() });
    if (Math.abs(speed - this.shift.speed) >= 1e-3 || Math.abs(semitones - this.shift.semitones) >= 5e-3) await this.startShift(speed, semitones);
  }

  /** The loop's region on the tracks as they play now; from its start when `start`. */
  private applyLoop(start: boolean) {
    const loop = this.loopState;
    if (!loop) return;
    const speed = this.shift.speed;
    this.host.loop(loop.from / speed, loop.to / speed);
    if (start) {
      this.host.seek(loop.from / speed, true);
      this.lastPosition = loop.from / speed;
      this.restartFrom(loop.from / speed);
    }
  }

  //==============================================================================
  private async findSections() {
    const current = this.current;
    if (!current) {
      this.host.emit("practice", { state: "sections", sections: null, error: "Open a song first." });
      return;
    }
    if (current.sections === "finding") return;
    if (Array.isArray(current.sections)) {
      this.host.emit("practice", { state: "sections", sections: current.sections });
      return;
    }
    current.sections = "finding";
    this.host.emit("practice", { state: "sections", sections: "finding" });
    try {
      const { guide, backing } = await this.originalFiles(current);
      const parts = await Promise.all([guide, backing].filter((f): f is File => Boolean(f)).map((f) => this.host.decode(f, RATE)));
      const length = Math.max(...parts.map((p) => p[0]!.length));
      const mix = new Float32Array(length);
      for (const channels of parts) for (const channel of channels) for (let i = 0; i < channel.length; ++i) mix[i]! += channel[i]! / channels.length;
      const sections = await this.host.sections(mix, RATE);
      if (this.current !== current) return;
      current.sections = sections;
      await this.host.store.write(current.folder, SECTIONS, JSON.stringify(sections)).catch(() => {});
      this.host.emit("practice", { state: "sections", sections });
    } catch (error) {
      if (this.current !== current) return;
      current.sections = null;
      this.host.emit("practice", { state: "sections", sections: null, error: `Couldn't find the sections: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  private async setCurrent(folder: string, info: Info, melody: string, guideId: number | undefined, part: Part = "lead") {
    this.scorer ??= await this.host.scorer();
    this.part = part;
    const song = this.scorer.scoreSong(partMelody(melody, info.key, part));
    const kept = await (await this.host.store.read(folder, LYRICS))?.text().catch(() => "");
    const lyrics = kept ? this.scorer.lyricsSet(kept, true) : undefined;
    this.lastLrc = lyrics?.lrc ?? "";
    let sections: SongSection[] | null = null;
    try {
      const text = await (await this.host.store.read(folder, SECTIONS))?.text();
      if (text) sections = JSON.parse(text) as SongSection[];
    } catch {
      // found again when asked
    }
    this.current = { folder, info, melody, song, base: song, guideId, lyrics: lyrics?.lines ?? [], sections };
    this.trail = [];
    this.passes = parsePasses(await (await this.host.store.read(folder, historyFile(part)))?.text().catch(() => undefined));
    this.shift = { speed: 1, semitones: 0 };
    this.pending = undefined;
    this.shiftToken++;
    if (this.loopState) this.host.loop();
    this.loopState = undefined;
    this.lastPosition = -1;
    this.lastSongTime = 0;
    this.persist();
  }

  private restartFrom(songTime: number) {
    if (this.current) this.scorer?.scoreRestart(songTime);
    // What was sung from here on is sung again.
    let keep = 0;
    while (keep < this.trail.length && this.trail[keep]! < songTime) keep += 2;
    this.trail.length = keep;
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
      part: this.part,
      key: current.info.key,
      shift: this.describeShift(),
      lyrics: this.describeLyrics(),
      sections: current.sections,
      loop: this.loopState
        ? { ...this.loopState, from: round3(this.loopState.from), to: round3(this.loopState.to) }
        : null,
    };
  }

  private describeJob() {
    const job = this.job;
    return job ? { phase: job.phase, progress: round3(job.progress), name: job.name } : null;
  }

  /** A whole pass: kept with the song. */
  private recordPass(report: Record<string, unknown>) {
    const current = this.current;
    const pass = current ? passFrom(report, this.now(), this.shift) : undefined;
    if (!current || !pass) return;
    this.passes = addPass(this.passes, pass);
    void this.host.store.write(current.folder, historyFile(this.part), JSON.stringify(this.passes)).catch(() => {});
  }

  /** The time a song's split takes (before it starts) or has left (while it runs). */
  splitLeft(): { seconds: number; started: boolean } | undefined {
    const job = this.job;
    if (!job?.seconds || !["downloading", "loading", "splitting"].includes(job.phase)) return undefined;
    // Before it starts: the whole split; then, what's left of it.
    if (job.phase !== "splitting" || job.splitFrom === undefined) return { seconds: splitSecondsLeft({ seconds: job.seconds, progress: 0, elapsed: 0 }), started: false };
    return { seconds: splitSecondsLeft({ seconds: job.seconds, progress: job.progress, elapsed: (this.now() - job.splitFrom) / 1000 }), started: true };
  }

  /** The part sung now. */
  currentPart(): Part {
    return this.part;
  }

  /**
   * Sings another part of the song: its notes are a harmony a third above or below the
   * melody (or the melody again), scored on their own with their own passes. The music and
   * guide stay as they are, so a second singer can take the lead beside you.
   */
  async setPart(part: Part): Promise<void> {
    const current = this.current;
    if (!current || !this.scorer || part === this.part) return;
    this.part = part;
    const position = Math.max(0, this.lastSongTime);
    current.base = this.scorer.scoreSong(partMelody(current.melody, current.info.key, part));
    current.song = this.shift.speed !== 1 || this.shift.semitones !== 0 ? this.scorer.scoreShift(this.shift.semitones, this.shift.speed, position) : current.base;
    // The lyrics sit on the same notes.
    const kept = await (await this.host.store.read(current.folder, LYRICS))?.text().catch(() => "");
    if (kept) current.lyrics = this.scorer.lyricsSet(kept, true).lines;
    this.passes = parsePasses(await (await this.host.store.read(current.folder, historyFile(part)))?.text().catch(() => undefined));
    this.trail = [];
    if (this.loopState) this.applyLoop(false);
    this.restartFrom(position);
    this.persist();
    this.host.emit("practice", { state: "ready", song: this.describeSong(), fromCache: true, quiet: true });
  }

  /** Each pitch reading while Practice is open; returns the way to stop. */
  listenPitch(listener: (midi: number) => void): () => void {
    this.pitchListeners.add(listener);
    return () => this.pitchListeners.delete(listener);
  }

  /** The song's notes as recorded (lowest, highest MIDI) and the key and speed it plays in. */
  songRange(): { name: string; lowest: number; highest: number; semitones: number; speed: number } | undefined {
    const current = this.current;
    if (!current || !current.base.notes.length) return undefined;
    return { name: current.info.name, lowest: current.base.lowest, highest: current.base.highest, semitones: this.shift.semitones, speed: this.shift.speed };
  }

  /** Plays the song in another key (and speed), as the Key menu does. */
  setShift(semitones: number, speed = this.shift.speed): Promise<unknown> {
    return this.handle("speed", { speed, semitones });
  }

  /**
   * A song made here (a warm-up): its guide voice, backing and melody are known, so it's
   * kept and opened like a prepared song without listening for the melody.
   */
  async prepareMade(made: { name: string; key: string; seconds: number; guide: Float32Array; backing?: [Float32Array, Float32Array]; melody: string }): Promise<boolean> {
    if (this.job) this.job.cancelled = true;
    this.job = undefined;
    try {
      const guide = this.host.encodeWav([made.guide], RATE);
      const backing = made.backing ? this.host.encodeWav(made.backing, RATE) : undefined;
      const folder = `${await fileId(new Blob([guide, made.melody]))}${backing ? "" : "-voice"}`;
      const info: Info = { name: made.name, key: made.key, seconds: round3(made.seconds), voiceOnly: !backing, opened: this.now(), guide: GUIDE, backing: backing ? BACKING : "" };
      if (!(await this.loadFolder(folder))) {
        await this.host.store.write(folder, GUIDE, guide);
        if (backing) await this.host.store.write(folder, BACKING, backing);
        await this.host.store.write(folder, MELODY, made.melody);
        await this.host.store.write(folder, INFO, JSON.stringify(info));
      }
      const error = await this.install(folder, info, made.melody);
      if (error) {
        this.host.emit("practice", { state: "error", error });
        return false;
      }
      this.host.emit("practice", { state: "ready", song: this.describeSong(), fromCache: false });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.host.emit("practice", { state: "error", error: /quota/i.test(message) ? "This browser has no room left to keep the song." : `Couldn't make ${made.name}: ${message}` });
      return false;
    }
  }

  /** The song's passes, for the progress chart. */
  history(): { name: string; passes: Pass[] } | undefined {
    return this.current ? { name: this.current.info.name, passes: this.passes } : undefined;
  }

  /** What the result card shows: the song, its notes as they play, the report and what you sang. */
  card(): { name: string; key: string; shift: Shift; notes: number[]; trail: number[]; report: Record<string, unknown> } | undefined {
    const current = this.current;
    if (!current || !this.scorer) return undefined;
    return { name: current.info.name, key: current.info.key, shift: { ...this.shift }, notes: current.song.notes, trail: [...this.trail], report: this.scorer.scoreReport() };
  }

  private persist() {
    this.host.save(JSON.stringify({ guideLevel: this.guideLevel, folder: this.current?.folder ?? "", guideId: this.current?.guideId ?? -1, shift: this.shift, part: this.part }));
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
