// The microphone for Capture: no effects, only the mic's samples going to a file. The mic is
// open while the Capture screen is showing (so a 2 s "pre-roll" can keep what came just
// before the tap) and closed when the page is hidden.
import { micConstraints, readAudioPrefs } from "@micfx/engine/audio-prefs";
import workletUrl from "./capture-worklet?worker&url";
import { defaultName, newId, openWriter, saveIdea, type AudioWriter, type Idea } from "./store";
import { toInt16 } from "./wav";

export interface CaptureSettings {
  /** Keep the last 2 s from before the tap. */
  preroll: boolean;
  /** "" is the browser's choice. */
  deviceId: string;
}

export const PREROLL_SECONDS = 2;
const BAR_SECONDS = 0.05;
const SAVE_EVERY_MS = 3000;

export type MicState = "closed" | "opening" | "open" | "denied" | "busy";

export class CaptureRecorder {
  state: MicState = "closed";
  onState: () => void = () => {};
  /** Peak level 0..1 of each block, as it arrives. */
  onLevel: (peak: number) => void = () => {};
  /** A recording stopped on its own (a call, the screen locking). */
  onInterrupted: (idea: Idea) => void = () => {};
  onBar: (bar: number) => void = () => {};

  private context: AudioContext | undefined;
  private stream: MediaStream | undefined;
  private node: AudioWorkletNode | undefined;
  private ring: Float32Array[] = [];
  private ringFrames = 0;
  private writer: AudioWriter | undefined;
  private idea: Idea | undefined;
  private frames = 0;
  private bars: number[] = [];
  private barPeak = 0;
  private barFrames = 0;
  private saveTimer = 0;
  private lastSave = 0;
  private starting: Promise<void> | undefined;
  settings: CaptureSettings = { preroll: true, deviceId: "" };

  get recording(): boolean { return Boolean(this.idea); }
  get rate(): number { return this.context?.sampleRate ?? 48000; }
  get seconds(): number { return this.frames / this.rate; }
  get running(): boolean { return this.context?.state === "running"; }
  get liveBars(): number[] { return this.bars; }
  get current(): Idea | undefined { return this.idea; }

  private set(state: MicState) { this.state = state; this.onState(); }

  /** Opens the mic. Call it from a tap (a browser needs that to start audio), or on load when the mic was allowed before. */
  open(): Promise<void> {
    this.starting ??= this.doOpen().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async doOpen() {
    if (this.state === "open" && this.context && this.context.state !== "closed") { await this.context.resume().catch(() => {}); return; }
    this.set("opening");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(readAudioPrefs(), this.settings.deviceId || undefined, 1) });
    } catch (error) {
      const name = (error as DOMException).name;
      this.set(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "busy");
      return;
    }
    const context = new AudioContext({ latencyHint: "interactive" });
    this.context = context;
    await context.audioWorklet.addModule(workletUrl);
    const source = context.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(context, "micfx-capture", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: "explicit" });
    this.node = node;
    node.port.onmessage = (event: MessageEvent<Float32Array>) => this.block(event.data);
    source.connect(node);
    // The mic going away (unplugged, another app took it) or the system stopping the audio (a call).
    this.stream.getAudioTracks().forEach((track) => track.addEventListener("ended", () => void this.lost()));
    context.addEventListener("statechange", () => {
      if (context.state !== "running" && context.state !== "closed" && this.recording) void this.lost();
      this.onState();
    });
    await context.resume().catch(() => {});
    this.set("open");
  }

  /** Closes the mic (the page was hidden). A recording in progress goes on only while the mic stays open. */
  close() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.node?.disconnect();
    void this.context?.close().catch(() => {});
    this.stream = undefined; this.node = undefined; this.context = undefined;
    this.ring = []; this.ringFrames = 0;
    this.set("closed");
  }

  private block(samples: Float32Array) {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]!); if (a > peak) peak = a; }
    this.onLevel(peak);
    if (this.idea) { this.push(samples); return; }
    if (!this.settings.preroll) return;
    this.ring.push(samples);
    this.ringFrames += samples.length;
    const keep = PREROLL_SECONDS * this.rate;
    while (this.ring.length > 1 && this.ringFrames - this.ring[0]!.length >= keep) this.ringFrames -= this.ring.shift()!.length;
  }

  private push(samples: Float32Array) {
    this.writer?.write(toInt16(samples));
    this.frames += samples.length;
    let at = 0;
    const barLength = Math.round(BAR_SECONDS * this.rate);
    while (at < samples.length) {
      const n = Math.min(barLength - this.barFrames, samples.length - at);
      for (let i = at; i < at + n; i++) { const a = Math.abs(samples[i]!); if (a > this.barPeak) this.barPeak = a; }
      this.barFrames += n; at += n;
      if (this.barFrames >= barLength) {
        this.bars.push(this.barPeak);
        this.onBar(this.barPeak);
        this.barPeak = 0; this.barFrames = 0;
      }
    }
    const now = Date.now();
    if (this.idea && now - this.lastSave > SAVE_EVERY_MS) { this.lastSave = now; void this.saveProgress(); }
  }

  private saveProgress() {
    if (!this.idea) return Promise.resolve();
    this.idea = { ...this.idea, length: this.seconds, peaks: shrink(this.bars) };
    return saveIdea(this.idea);
  }

  /** Starts a take. The mic must be open. */
  async start(parent?: string): Promise<Idea> {
    if (this.idea) return this.idea;
    if (!this.context || this.state !== "open") throw new Error("The microphone isn't open.");
    await this.context.resume().catch(() => {});
    const id = newId();
    const rate = this.rate;
    const idea: Idea = {
      id, name: defaultName(), created: Date.now(), length: 0, rate, starred: false, note: "", peaks: [], markers: [], status: "recording", ...(parent ? { parent } : {}),
    };
    this.writer = await openWriter(id, rate);
    this.idea = idea;
    this.frames = 0; this.bars = []; this.barPeak = 0; this.barFrames = 0; this.lastSave = Date.now();
    await saveIdea(idea); // "recording": if the page dies now, the next launch finds it
    // What came just before the tap.
    const before = this.ring;
    this.ring = []; this.ringFrames = 0;
    for (const chunk of before) this.push(chunk);
    return idea;
  }

  mark(): number {
    if (!this.idea) return 0;
    const at = this.seconds;
    this.idea = { ...this.idea, markers: [...this.idea.markers, Math.round(at * 10) / 10] };
    return at;
  }

  /** Stops, finishes the file and returns the saved idea. */
  async stop(interrupted = false): Promise<Idea | undefined> {
    const idea = this.idea;
    if (!idea) return undefined;
    this.idea = undefined;
    const frames = await this.writer?.close();
    this.writer = undefined;
    const length = (frames ?? this.frames) / idea.rate;
    const done: Idea = {
      ...idea, length, peaks: shrink(this.bars), status: "saved", ...(interrupted ? { interrupted: length } : {}),
    };
    await saveIdea(done);
    return done;
  }

  private async lost() {
    if (!this.recording) return;
    const idea = await this.stop(true);
    if (idea) this.onInterrupted(idea);
  }
}

/** About 240 bars, 0..100, from the loudness every 50 ms. */
export function shrink(bars: number[], count = 240): number[] {
  if (!bars.length) return [];
  const n = Math.min(count, bars.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * bars.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * bars.length) / n));
    let peak = 0;
    for (let j = from; j < to; j++) peak = Math.max(peak, bars[j]!);
    out.push(Math.round(Math.min(1, Math.sqrt(peak)) * 100));
  }
  return out;
}
