// Sound check on the web: the desktop's SoundCheck (src/SoundCheck.cpp). Sing for 10 to 20
// seconds and the Live chain is set for this voice, mic and room.
//
// The worklet sends the raw mic in 0.1 s chunks; here they are scaled by the input gain (the
// desktop captures after it), the level is followed, and when enough is in, the desktop's
// planner (analysis.wasm, in a Worker) makes the plan. Its values are applied at once; the
// values from before are kept for Before / After and Revert, and the result can be saved as
// a scene.
import { MIX_STYLES, type FitChain, type SoundCheckPlan } from "@micfx/engine/analysis";
import type { ParameterAccess } from "./live-state";

export const MAX_SECONDS = 20;
export const DEFAULT_SECONDS = 15;
export const MIN_SECONDS = 6;
export const MIN_VOICE_SECONDS = 4;
const MAX_SCENES = 8;

type Phase = "idle" | "listening" | "analysing" | "done";

export interface SoundCheckHost {
  params: ParameterAccess;
  /** Starts or stops the raw mic chunks (the caller feeds them to capture()). False when the sound can't start. */
  listen(on: boolean): Promise<boolean> | boolean;
  /** The desktop planner (analysis.wasm). */
  plan(mono: Float32Array, sampleRate: number, options: { style?: number; fit?: FitChain }): Promise<SoundCheckPlan>;
  /** The room's profile to the playing denoiser; false when it couldn't take it. */
  offerNoiseProfile(bins: Float32Array): Promise<boolean>;
  /** Adds a scene with the sound there is now; its index, or -1 when there's no room. */
  addScene(name: string): number;
  sceneName(index: number): string;
  onChange(state: ReturnType<SoundCheck["describe"]>): void;
  now?(): number;
}

export class SoundCheck {
  private readonly styles = MIX_STYLES;
  private phase: Phase = "idle";
  private style = 0;
  private fit = false;
  private sampleRate = 48000;
  private buffer = new Float32Array(0);
  private written = 0;
  private target = 0;
  private voiceSeconds = 0;
  private levelDb = -100;
  private scanned = 0;
  private lastWritten = 0;
  private stalled = 0;
  private lastTick = 0;
  private ticks = 0;
  private plan: SoundCheckPlan | undefined;
  private before: [string, number][] = [];
  private comparingAfter = true;
  private error = "";
  private sceneName = "";
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly host: SoundCheckHost) {}

  private now() {
    return this.host.now?.() ?? performance.now();
  }

  /** The page's "soundCheck" native function. */
  async handle(action: string, options: Record<string, unknown> = {}) {
    if (action === "start" && this.phase !== "listening" && this.phase !== "analysing") {
      if (this.phase === "done") await this.handle("keep");
      const seconds = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Number(options.seconds ?? DEFAULT_SECONDS) || DEFAULT_SECONDS));
      this.fit = Boolean(options.fit);
      const style = Number(options.style ?? this.style);
      if (Number.isInteger(style) && style >= 0 && style < this.styles.length) this.style = style;
      this.error = "";
      this.sceneName = "";
      this.plan = undefined;
      this.before = [];
      this.written = this.scanned = this.lastWritten = 0;
      this.voiceSeconds = this.stalled = 0;
      this.levelDb = -100;
      // The mic first: starting the sound sets the rate (prepare()).
      if (!(await this.host.listen(true))) {
        this.error = "Start the sound first: the sound check needs your microphone.";
        return this.describe();
      }
      const capacity = Math.ceil(MAX_SECONDS * this.sampleRate);
      if (this.buffer.length !== capacity) this.buffer = new Float32Array(capacity);
      this.target = Math.min(capacity, Math.round(seconds * this.sampleRate));
      this.phase = "listening";
      this.lastTick = this.now();
      this.startTimer();
    } else if (action === "finish" && this.phase === "listening") {
      this.target = this.written; // what's in is enough
    } else if (action === "cancel" && this.phase === "listening") {
      void this.host.listen(false);
      this.phase = "idle";
      this.stopTimer();
    } else if (action === "compare" && this.phase === "done" && this.plan) {
      this.comparingAfter = options.after !== false;
      this.setValues(this.comparingAfter ? this.plan.values : this.before);
    } else if (action === "revert" && this.phase === "done") {
      this.setValues(this.before);
      this.phase = "idle";
      this.before = [];
    } else if ((action === "keep" || action === "saveScene") && this.phase === "done" && this.plan) {
      if (!this.comparingAfter) this.setValues(this.plan.values);
      this.comparingAfter = true;
      if (action === "saveScene") {
        const name = String(options.name ?? "").trim();
        const index = this.host.addScene(name || "Sound check");
        if (index < 0) this.error = `There are already ${MAX_SCENES} scenes: remove one to save this sound.`;
        else this.sceneName = this.host.sceneName(index);
      }
      if (!this.error) {
        this.phase = "idle";
        this.before = [];
      }
    }
    return this.describe();
  }

  /** The audio started (or restarted) at a rate. A capture running then stops, as the desktop's prepare(). */
  prepare(sampleRate: number): void {
    if (sampleRate !== this.sampleRate) this.buffer = new Float32Array(0);
    this.sampleRate = sampleRate;
    if (this.phase === "listening") {
      void this.host.listen(false);
      this.phase = "idle";
      this.stopTimer();
      this.error = "The audio device changed: start the sound check again.";
      this.host.onChange(this.describe());
    }
  }

  /** Mic samples, already scaled by the input gain. */
  capture(samples: Float32Array): void {
    if (this.phase !== "listening") return;
    const count = Math.min(samples.length, this.target - this.written);
    if (count > 0) this.buffer.set(samples.subarray(0, count), this.written);
    this.written += Math.max(0, count);
  }

  /** About 30 times a second while listening or analysing (the timer); tests call it. */
  tick(): void {
    if (this.phase !== "listening") return;
    const now = this.now();
    const elapsed = (now - this.lastTick) / 1000;
    this.lastTick = now;
    this.scanLevels();

    // No audio coming in (the device stopped): nothing will finish the capture.
    this.stalled = this.written === this.lastWritten ? this.stalled + elapsed : 0;
    this.lastWritten = this.written;

    if (this.written >= this.target) {
      void this.analyse();
      return;
    }
    if (this.stalled > 2) {
      void this.host.listen(false);
      return this.fail("No sound is coming in from the mic. Check the audio device in Settings and try again.");
    }
    if (++this.ticks % 3 === 0) this.host.onChange(this.describe());
  }

  describe() {
    const round1 = (value: number) => Math.round(value * 10) / 10;
    const plan = this.plan;
    return {
      phase: this.phase,
      seconds: round1(this.written / this.sampleRate),
      target: round1(this.target / this.sampleRate),
      voiceSeconds: round1(this.voiceSeconds),
      level: round1(this.levelDb),
      canFinish: this.phase === "listening" && this.voiceSeconds >= MIN_VOICE_SECONDS,
      minVoiceSeconds: MIN_VOICE_SECONDS,
      error: this.error,
      scene: this.sceneName,
      fit: this.fit,
      style: this.style,
      styles: this.styles,
      ...(this.phase === "done" && plan
        ? {
            changes: plan.changes,
            notes: plan.notes,
            advice: plan.advice,
            peak: plan.peak,
            noise: plan.noise,
            sung: plan.sung,
            comparing: this.comparingAfter ? "after" : "before",
          }
        : {}),
    };
  }

  //==============================================================================
  private scanLevels() {
    const hop = Math.max(1, Math.round(this.sampleRate * 0.1));
    while (this.scanned + hop <= this.written) {
      let sum = 0;
      for (let i = this.scanned; i < this.scanned + hop; ++i) sum += this.buffer[i]! * this.buffer[i]!;
      const rms = Math.sqrt(sum / hop);
      this.levelDb = rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
      // A rough count for the page (the analysis decides properly): louder than a quiet room.
      if (this.levelDb > -50) this.voiceSeconds += 0.1;
      this.scanned += hop;
    }
  }

  private async analyse() {
    void this.host.listen(false);
    this.stopTimer();
    this.phase = "analysing";
    this.host.onChange(this.describe());

    const mono = this.buffer.slice(0, Math.min(this.written, this.buffer.length));
    let plan: SoundCheckPlan;
    try {
      plan = await this.host.plan(mono, this.sampleRate, this.fit ? { fit: this.fitChain() } : { style: this.style });
    } catch (error) {
      return this.fail(`The sound check couldn't finish: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.phase !== "analysing") return; // cancelled meanwhile
    if (plan.error) {
      this.plan = undefined;
      return this.fail(plan.error);
    }

    // The values from before, for Before / After and Revert.
    this.before = plan.values.filter(([id]) => this.host.params.info[id]).map(([id]) => [id, this.host.params.get(id)]);
    if (plan.noiseProfile.length && !(await this.host.offerNoiseProfile(plan.noiseProfile)))
      plan.notes.push("The denoiser couldn't take the room's profile (the sample rate changed?): it learns the room by itself.");

    this.plan = plan;
    this.setValues(plan.values);
    this.comparingAfter = true;
    this.phase = "done";
    this.host.onChange(this.describe());
  }

  /** What the chain has now, for a fit. */
  private fitChain(): FitChain {
    const { params } = this.host;
    const value = (id: string, fallback: number) => (params.info[id] ? params.get(id) : fallback);
    const input = params.info.inputGain;
    return {
      inputGainDb: value("inputGain", 0),
      minInputDb: input?.min ?? -24,
      maxInputDb: input?.max ?? 24,
      gate: value("gateOn", 0) >= 0.5,
      classicDeEsser: value("deessOn", 0) >= 0.5 && value("deessMode", 0) < 0.5,
      denoise: value("denoiseOn", 0) >= 0.5,
      lowCutHz: value("hpfOn", 0) >= 0.5 ? value("hpfFreq", 80) : 0,
    };
  }

  private setValues(values: [string, number][]) {
    const { params } = this.host;
    for (const [id, value] of values) if (params.info[id] && Math.abs(params.get(id) - value) > 1e-6) params.set(id, value);
  }

  private fail(message: string) {
    this.error = message;
    this.phase = "idle";
    this.stopTimer();
    this.host.onChange(this.describe());
  }

  private startTimer() {
    this.stopTimer();
    this.timer = setInterval(() => this.tick(), 1000 / 30);
  }

  private stopTimer() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
