// The sing-along session on the audio thread: tracks (backing songs and recorded takes)
// on a timeline, the transport, and the recorder. The web version of the desktop's
// Multitrack and Recorder (src/Multitrack.cpp, src/Recorder.cpp): the tracks play under the
// voice after its limiter, a -1 dB guard keeps the sum from clipping, and a take is the voice
// as you hear it (and, if asked, the dry mic), without the music.

import { Metronome } from "./metronome";

export interface TrackOptions {
  gain?: number;
  muted?: boolean;
}

interface Track {
  id: number;
  /** One or two channels at the session's rate. */
  channels: Float32Array[];
  /** Timeline position of its first sample, in frames. */
  start: number;
  gain: number;
  muted: boolean;
}

/** Recorded audio, handed over about once a second. */
export interface TakeChunk {
  channels: [Float32Array, Float32Array];
  dry?: Float32Array;
  /** The live input (a browser tab) as it played, when it was on as the take started. */
  backing?: [Float32Array, Float32Array];
}

/** A live input's two channels for one block (the same array twice for mono). */
export type LiveBlock = [Float32Array, Float32Array];

/** Where a finished take sits and how long it is, in frames. */
export interface TakeEnd {
  start: number;
  frames: number;
}

export type TransportAction = "play" | "pause" | "stop" | "seek";

const CEILING = 0.89125; // -1 dB, as the desktop's applyPeakGuard

export class Session {
  /** The click, on this session's beat grid. */
  readonly metronome: Metronome;
  /** Playhead, in frames. */
  position = 0;
  playing = false;
  /** A region that plays round and round (frames), or none. */
  loop: { from: number; to: number } | undefined;
  private tracks: Track[] = [];
  private guardGain = 1;
  private readonly guardRelease: number;
  private readonly chunkFrames: number;

  private recording = false;
  /** Frames left of a count-in before the take starts (and the transport with it). */
  private countIn = 0;
  private recordDry = false;
  private recordBacking = false;
  /** A live input (a browser tab) plays under the voice while on. */
  liveOn = false;
  liveGain = 1;
  private recordStart = 0;
  private recorded = 0;
  private chunk: TakeChunk | undefined;
  private chunkUsed = 0;

  constructor(
    readonly sampleRate: number,
    private readonly onChunk: (chunk: TakeChunk) => void,
  ) {
    this.guardRelease = 1 - Math.exp(-1 / (0.1 * sampleRate)); // ~100 ms
    this.chunkFrames = Math.round(sampleRate);
    this.metronome = new Metronome(sampleRate);
  }

  /** The end of the last track, in frames. */
  get length(): number {
    let end = 0;
    for (const track of this.tracks) end = Math.max(end, track.start + (track.channels[0]?.length ?? 0));
    return end;
  }

  get trackCount(): number {
    return this.tracks.length;
  }

  /** Seconds recorded, or -1 when not recording. */
  get recordingSeconds(): number {
    return this.recording && this.countIn === 0 ? this.recorded / this.sampleRate : -1;
  }

  /** Beats left of the count-in (rounded up), 0 when there's none. */
  get countInBeats(): number {
    return this.countIn > 0 ? Math.ceil(this.countIn / this.metronome.beatFrames - 1e-9) : 0;
  }

  addTrack(id: number, channels: Float32Array[], start: number, options: TrackOptions = {}): void {
    this.removeTrack(id);
    if (channels.length === 0) return;
    this.tracks.push({ id, channels, start: Math.max(0, Math.round(start)), gain: options.gain ?? 1, muted: options.muted ?? false });
  }

  removeTrack(id: number): void {
    this.tracks = this.tracks.filter((track) => track.id !== id);
  }

  setTrack(id: number, options: TrackOptions): void {
    const track = this.tracks.find((t) => t.id === id);
    if (!track) return;
    if (options.gain !== undefined && Number.isFinite(options.gain)) track.gain = Math.max(0, Math.min(4, options.gain));
    if (options.muted !== undefined) track.muted = options.muted;
  }

  /** Loops `from`..`to` seconds (Practice's phrase and section loops); undefined ends it. */
  setLoop(from?: number, to?: number): void {
    if (from === undefined || to === undefined || !(to > from)) {
      this.loop = undefined;
      return;
    }
    this.loop = { from: Math.max(0, Math.round(from * this.sampleRate)), to: Math.round(to * this.sampleRate) };
  }

  transport(action: TransportAction, seconds?: number): void {
    switch (action) {
      case "play":
        this.playing = true;
        break;
      case "pause":
        this.playing = false;
        break;
      case "stop":
        this.playing = false;
        this.position = 0;
        this.metronome.anchor = 0;
        break;
      case "seek":
        this.position = Math.max(0, Math.round((seconds ?? 0) * this.sampleRate));
        break;
    }
  }

  /**
   * Starts a take where the playhead is, and plays (as the desktop's Record); after
   * `countInBars` of clicks when asked, with beat 1 where the take starts.
   */
  startRecording(includeDry: boolean, countInBars = 0): void {
    if (this.recording) this.stopRecording();
    this.recording = true;
    this.recordDry = includeDry;
    this.recordBacking = this.liveOn;
    this.recordStart = this.position;
    this.recorded = 0;
    this.metronome.anchor = this.position;
    this.countIn = countInBars > 0 ? this.metronome.countInFrames(countInBars) : 0;
    this.playing = this.countIn === 0;
  }

  /** Ends the take: the last chunk goes out, then where it belongs. Pauses, as the desktop does. */
  stopRecording(): TakeEnd | undefined {
    if (!this.recording) return undefined;
    this.flush();
    this.recording = false;
    this.playing = false;
    this.countIn = 0;
    return { start: this.recordStart, frames: this.recorded };
  }

  /**
   * After the engine, with the voice in left/right and the mic that went in. Records the
   * voice, then adds the tracks under it while playing.
   */
  process(left: Float32Array, right: Float32Array, mic: Float32Array, frames: number, live?: LiveBlock): void {
    // A count-in: clicks, then the take and the transport start mid-block.
    if (this.countIn > 0) {
      const count = Math.min(frames, this.countIn);
      if (this.addLive(left, right, live, 0, count)) this.guard(left, right, count);
      this.metronome.process(left, right, 0, count, -this.countIn, true);
      this.countIn -= count;
      if (this.countIn > 0) return;
      this.playing = true;
      const rest = (a: Float32Array) => a.subarray(count);
      if (count < frames)
        this.process(rest(left), right === left ? rest(left) : rest(right), rest(mic), frames - count, live && [rest(live[0]), live[1] === live[0] ? rest(live[0]) : rest(live[1])]);
      return;
    }
    if (this.recording) this.record(left, right, mic, frames, live);
    if (!this.playing) {
      if (this.addLive(left, right, live, 0, frames) || this.guardGain < 1) this.guard(left, right, frames);
      this.metronome.process(left, right, 0, frames, undefined);
      return;
    }
    const clickFrom = this.position;

    // A loop: the block is played in parts, going back to its start at its end.
    let mixed = this.addLive(left, right, live, 0, frames);
    let done = 0;
    while (done < frames) {
      const loop = this.loop;
      if (loop && this.position >= loop.to) this.position = loop.from;
      const count = loop && this.position < loop.to ? Math.min(frames - done, loop.to - this.position) : frames - done;
      mixed = this.mix(left, right, done, count) || mixed;
      this.position += count;
      done += count;
      if (loop && this.position >= loop.to) this.position = loop.from;
    }
    if (mixed || this.guardGain < 1) this.guard(left, right, frames);
    // The click after the guard, on the transport's grid (loops jump it, as they should).
    if (this.metronome.on) this.click(left, right, clickFrom, frames);
  }

  /** The live input under the voice; true when it played. */
  private addLive(left: Float32Array, right: Float32Array, live: LiveBlock | undefined, offset: number, frames: number): boolean {
    if (!live || !this.liveOn || this.liveGain === 0) return false;
    const gain = this.liveGain;
    const [l, r] = live;
    const n = Math.min(frames, l.length - offset);
    for (let i = 0; i < n; ++i) {
      left[i]! += l[offset + i]! * gain;
      right[i]! += r[offset + i]! * gain;
    }
    return n > 0;
  }

  private click(left: Float32Array, right: Float32Array, from: number, frames: number) {
    const loop = this.loop;
    let position = from;
    let done = 0;
    while (done < frames) {
      if (loop && position >= loop.to) position = loop.from;
      const count = loop && position < loop.to ? Math.min(frames - done, loop.to - position) : frames - done;
      this.metronome.process(left, right, done, count, position - this.metronome.anchor);
      position += count;
      done += count;
    }
  }

  /** The tracks from the playhead into `left`/`right` at `offset`, `frames` of them; true when any played. */
  private mix(left: Float32Array, right: Float32Array, offset: number, frames: number): boolean {
    const blockStart = this.position;
    const blockEnd = blockStart + frames;
    let mixed = false;
    for (const track of this.tracks) {
      if (track.muted || track.gain === 0) continue;
      const length = track.channels[0]!.length;
      const from = Math.max(blockStart, track.start);
      const to = Math.min(blockEnd, track.start + length);
      if (from >= to) continue;
      const l = track.channels[0]!;
      const r = track.channels[1] ?? l;
      const gain = track.gain;
      for (let t = from; t < to; ++t) {
        const i = t - blockStart + offset;
        const s = t - track.start;
        left[i]! += l[s]! * gain;
        right[i]! += r[s]! * gain;
      }
      mixed = true;
    }
    return mixed;
  }

  private guard(left: Float32Array, right: Float32Array, frames: number) {
    let gain = this.guardGain;
    for (let i = 0; i < frames; ++i) {
      const peak = Math.max(Math.abs(left[i]!), Math.abs(right[i]!));
      if (peak * gain > CEILING) gain = CEILING / peak; // instant attack: never overshoots
      else gain += (1 - gain) * this.guardRelease;
      if (gain < 0.9999) {
        left[i]! *= gain;
        right[i]! *= gain;
      }
    }
    this.guardGain = gain > 0.9999 ? 1 : gain;
  }

  private record(left: Float32Array, right: Float32Array, mic: Float32Array, frames: number, live?: LiveBlock) {
    let done = 0;
    while (done < frames) {
      if (!this.chunk) {
        this.chunk = {
          channels: [new Float32Array(this.chunkFrames), new Float32Array(this.chunkFrames)],
          dry: this.recordDry ? new Float32Array(this.chunkFrames) : undefined,
          backing: this.recordBacking ? [new Float32Array(this.chunkFrames), new Float32Array(this.chunkFrames)] : undefined,
        };
        this.chunkUsed = 0;
      }
      const count = Math.min(frames - done, this.chunkFrames - this.chunkUsed);
      this.chunk.channels[0].set(left.subarray(done, done + count), this.chunkUsed);
      this.chunk.channels[1].set(right.subarray(done, done + count), this.chunkUsed);
      this.chunk.dry?.set(mic.subarray(done, done + count), this.chunkUsed);
      // The tab as it came in (before its level): silence where it stopped.
      if (this.chunk.backing && live && this.liveOn) {
        this.chunk.backing[0].set(live[0].subarray(done, done + count), this.chunkUsed);
        this.chunk.backing[1].set(live[1].subarray(done, done + count), this.chunkUsed);
      }
      this.chunkUsed += count;
      done += count;
      if (this.chunkUsed === this.chunkFrames) this.flush();
    }
    this.recorded += frames;
  }

  private flush() {
    const chunk = this.chunk;
    if (!chunk || this.chunkUsed === 0) return;
    const used = this.chunkUsed;
    this.chunk = undefined;
    this.chunkUsed = 0;
    this.onChunk(
      used === this.chunkFrames
        ? chunk
        : {
            channels: [chunk.channels[0].slice(0, used), chunk.channels[1].slice(0, used)],
            dry: chunk.dry?.slice(0, used),
            backing: chunk.backing && [chunk.backing[0].slice(0, used), chunk.backing[1].slice(0, used)],
          },
    );
  }
}
