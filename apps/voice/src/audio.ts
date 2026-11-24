// The audio side of MicFX Voice: the mic, the AudioContext and the engine's worklet.
import { type RoundTrip, measureRoundTrip } from "@micfx/engine/calibration";
import wasmUrl from "@micfx/engine/engine.wasm?url";
import workletUrl from "@micfx/engine/worklet?worker&url";
import type { FromWorklet, ToWorklet, TransportState, Values } from "@micfx/engine/messages";
import type { TrackOptions, TransportAction } from "@micfx/engine/session";
import type { LooperCommand, LooperState } from "@micfx/engine";
import { instantiateEngineModule, type FactoryPreset, type Meters, type ParameterInfo, type ValueInfo } from "@micfx/engine";

export type { Meters, TransportState };

/** A finished take from the worklet: the voice (stereo) and, if asked, the dry mic. */
export interface RecordedTake {
  /** Timeline position of its first sample, in seconds (before latency correction). */
  start: number;
  seconds: number;
  sampleRate: number;
  channels: [Float32Array, Float32Array];
  dry?: Float32Array;
  /** The live input (a browser tab) as it came in during the take, when it was on. */
  backing?: [Float32Array, Float32Array];
}

/** The meters with the transport and the recorder, as the worklet sends them. */
export type LiveMeters = Meters & { transport?: TransportState; recording?: number; countIn?: number; status?: unknown; looper?: LooperState; pitch?: Float64Array; cpu?: number; late?: number };

export interface LiveAudioInfo {
  values: ValueInfo[];
  parameters: Record<string, ParameterInfo>;
  presets: FactoryPreset[];
  order: string[];
  sampleRate: number;
}

let compiled: Promise<WebAssembly.Module> | undefined;

export function compileEngine(): Promise<WebAssembly.Module> {
  compiled ??= (async () => {
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error(`Couldn't load the audio engine (${response.status})`);
    try {
      return await WebAssembly.compileStreaming(response.clone());
    } catch {
      return WebAssembly.compile(await response.arrayBuffer()); // served without application/wasm
    }
  })();
  return compiled;
}

/** The desktop parameters and factory presets, read from the engine before any audio starts. */
export async function loadCatalog(): Promise<{ parameters: Record<string, ParameterInfo>; presets: FactoryPreset[] }> {
  const engine = await createShadowEngine();
  const catalog = { parameters: engine.parameterInfo(), presets: engine.factoryPresets() };
  engine.dispose();
  return catalog;
}

/**
 * An engine on the page's own thread that never plays: it keeps the state (values, order,
 * presets) and its rules, so the page can answer at once and the worklet gets the same state
 * when the audio starts.
 */
export async function createShadowEngine() {
  return instantiateEngineModule(await compileEngine()).create(48000, 128);
}

/** Mic -> MicFX engine -> speakers/headphones. */
export class LiveAudio {
  onMeters: (meters: LiveMeters) => void = () => {};
  onMicChunk: (samples: Float32Array) => void = () => {};
  private profileTaken: ((ok: boolean) => void) | undefined;
  /** Every parameter's value after a preset load. */
  onValues: (values: Values, order: string[]) => void = () => {};
  private context: AudioContext | undefined;
  private node: AudioWorkletNode | undefined;
  private stream: MediaStream | undefined;
  private latencySamples = 0;
  private outputId = "";
  private inputId = "";
  private calibrated: ((reply: { mic: Float32Array; clicks: number[]; sampleRate: number }) => void) | undefined;
  private takeChunks: { channels: [Float32Array, Float32Array]; dry?: Float32Array; backing?: [Float32Array, Float32Array] }[] = [];
  /** A live sound (a browser tab) on the engine's second input, kept across restarts. */
  private liveStream: MediaStream | undefined;
  private liveSource: MediaStreamAudioSourceNode | undefined;
  private liveAnalyser: AnalyserNode | undefined;
  private liveGain = 1;
  private liveScratch: Float32Array<ArrayBuffer> | undefined;
  /** What you hear, as a stream (for a video), made on first use. */
  private outputTap: MediaStreamAudioDestinationNode | undefined;
  private takeDone: ((take: RecordedTake | undefined) => void) | undefined;
  private layersDone: ((layers: { layers: [Float32Array, Float32Array][]; sampleRate: number }) => void) | undefined;

  get running(): boolean {
    return this.context?.state === "running";
  }

  /** Starts the engine and opens the mic. Call from a click (browsers need a gesture for sound). */
  async start(deviceId?: string): Promise<LiveAudioInfo> {
    await this.stop();
    this.inputId = deviceId ?? "";
    const context = new AudioContext({ latencyHint: "interactive" });
    this.context = context;
    const [module] = await Promise.all([compileEngine(), context.audioWorklet.addModule(workletUrl)]);

    // The browser's own voice processing would fight the effects and add latency.
    this.stream = await navigator.mediaDevices
      .getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 1 },
        },
      })
      .catch(async (error: unknown) => {
        // No mic (blocked, unplugged): no half-started sound either.
        await this.stop();
        throw error;
      });

    // Input 0: the mic (made mono first); input 1: a live sound such as a browser tab, stereo.
    const node = new AudioWorkletNode(context, "micfx-live", {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
      processorOptions: { module },
    });
    this.node = node;

    const ready = new Promise<LiveAudioInfo>((resolve, reject) => {
      node.port.onmessage = (event: MessageEvent<FromWorklet>) => {
        const message = event.data;
        if (message.type === "ready") {
          const { values, parameters, presets, order, sampleRate } = message;
          resolve({ values, parameters, presets, order, sampleRate });
        } else if (message.type === "values") this.onValues(message.values, message.order);
        else if (message.type === "error") reject(new Error(message.message));
        else if (message.type === "meters") {
          this.latencySamples = message.latencySamples;
          this.onMeters(message);
        } else if (message.type === "takeChunk") this.takeChunks.push({ channels: message.channels, dry: message.dry, backing: message.backing });
        else if (message.type === "takeEnd") this.finishTake(message.start, message.frames);
        else if (message.type === "micChunk") this.onMicChunk(message.samples);
        else if (message.type === "noiseProfileTaken") {
          this.profileTaken?.(message.ok);
          this.profileTaken = undefined;
        } else if (message.type === "calibration") {
          this.calibrated?.(message);
          this.calibrated = undefined;
        } else if (message.type === "looperLayers") {
          this.layersDone?.({ layers: message.layers, sampleRate: message.sampleRate });
          this.layersDone = undefined;
        }
      };
    });

    if (this.outputId) await this.setOutput(this.outputId).catch(() => {});
    const mono = new GainNode(context, { channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers" });
    context.createMediaStreamSource(this.stream).connect(mono).connect(node, 0, 0);
    node.connect(context.destination);
    this.connectLive();
    await context.resume();
    return ready;
  }

  /** Plays through another output (where the browser can choose: Chrome, Edge). "" is the default. */
  async setOutput(deviceId: string): Promise<void> {
    this.outputId = deviceId;
    const context = this.context as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | undefined;
    await context?.setSinkId?.(deviceId);
  }

  async stop(): Promise<void> {
    this.finishTake(undefined, undefined);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.node?.disconnect();
    this.liveSource?.disconnect();
    this.liveSource = undefined;
    this.liveAnalyser = undefined;
    this.outputTap = undefined;
    await this.context?.close().catch(() => {});
    this.stream = undefined;
    this.node = undefined;
    this.context = undefined;
  }

  /**
   * A live sound under the voice (a browser tab's audio): heard at its level, and kept beside
   * each take. undefined takes it away. It stays across restarts of the sound.
   */
  setLiveInput(stream: MediaStream | undefined): void {
    this.liveStream = stream;
    this.connectLive();
  }

  /** The live input's level (linear gain). */
  setLiveGain(gain: number): void {
    this.liveGain = gain;
    this.post({ type: "liveInput", on: Boolean(this.liveSource), gain });
  }

  /** The live input's peak just now (linear), or undefined when there's none playing. */
  livePeak(): number | undefined {
    const analyser = this.liveAnalyser;
    if (!analyser) return undefined;
    this.liveScratch ??= new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(this.liveScratch);
    let peak = 0;
    for (const v of this.liveScratch) peak = Math.max(peak, Math.abs(v));
    return peak;
  }

  private connectLive() {
    this.liveSource?.disconnect();
    this.liveSource = undefined;
    this.liveAnalyser = undefined;
    const { context, node, liveStream } = this;
    if (!context || !node) return;
    if (liveStream?.getAudioTracks().some((track) => track.readyState === "live")) {
      this.liveSource = context.createMediaStreamSource(liveStream);
      this.liveAnalyser = new AnalyserNode(context, { fftSize: 2048 });
      this.liveSource.connect(node, 0, 1);
      this.liveSource.connect(this.liveAnalyser);
    }
    this.post({ type: "liveInput", on: Boolean(this.liveSource), gain: this.liveGain });
  }

  /** What you hear (the voice, the tracks, a tab) as a stream, for a video; undefined when stopped. */
  outputStream(): MediaStream | undefined {
    const { context, node } = this;
    if (!context || !node) return undefined;
    if (!this.outputTap) {
      this.outputTap = context.createMediaStreamDestination();
      node.connect(this.outputTap);
    }
    return this.outputTap.stream;
  }

  /** Whether meters carry the tuner and the effect cards' readings. */
  wantStatus(on: boolean): void {
    this.post({ type: "status", on });
  }

  /** Changes the order of the effects (module keys, first to last). */
  setOrder(keys: string[]): void {
    this.post({ type: "order", keys });
  }

  /** The AudioContext's rate, or undefined when stopped. */
  get sampleRate(): number | undefined {
    return this.context?.sampleRate;
  }

  /** The mic's name, when the browser tells it. */
  get deviceLabel(): string {
    return this.stream?.getAudioTracks()[0]?.label ?? "";
  }

  set(values: Values): void {
    this.post({ type: "set", values });
  }

  preset(values: Values, order?: string[]): void {
    this.post({ type: "preset", values, order });
  }

  /**
   * Round-trip latency estimate in ms: the browser's input and output buffering plus the
   * effects' own delay. Input latency isn't reported by browsers; it is taken to be about
   * the output's base latency.
   */
  latencyMs(): number | undefined {
    const context = this.context;
    if (!context) return undefined;
    const effects = this.latencySamples / context.sampleRate;
    const measured = this.measuredRoundTrip();
    if (measured !== undefined) return (measured + effects) * 1000;
    const base = context.baseLatency || 128 / context.sampleRate;
    const output = context.outputLatency || 0;
    return (base * 2 + output + effects) * 1000;
  }

  /** This mic, output and rate together: what a measured round trip belongs to. */
  private deviceKey(): string {
    return `${this.inputId || "default"}|${this.outputId || "default"}|${this.context?.sampleRate ?? 0}`;
  }

  /** The round trip measured on these devices (seconds, without the effects), if it was. */
  measuredRoundTrip(): number | undefined {
    const value = readLatencies()[this.deviceKey()];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  /** Forgets this device's measure: the browser's estimate is used again. */
  forgetRoundTrip(): void {
    const all = readLatencies();
    delete all[this.deviceKey()];
    writeLatencies(all);
  }

  /**
   * Plays clicks and hears them back (latency calibration): the round trip, kept for these
   * devices when it was heard clearly.
   */
  async calibrate(): Promise<RoundTrip & { seconds?: number }> {
    if (!this.node || !this.context) throw new Error("Start the sound first.");
    const reply = await new Promise<{ mic: Float32Array; clicks: number[]; sampleRate: number }>((resolve) => {
      this.calibrated = resolve;
      this.post({ type: "calibrate" });
    });
    const trip = measureRoundTrip(reply.mic, reply.clicks, reply.sampleRate);
    if (trip.frames === undefined) return trip;
    const seconds = trip.frames / reply.sampleRate;
    writeLatencies({ ...readLatencies(), [this.deviceKey()]: seconds });
    return { ...trip, seconds };
  }

  /** A desktop factory preset by index; onValues follows. */
  loadPreset(index: number): void {
    this.post({ type: "loadPreset", index });
  }

  /** A track on the timeline (channels at this context's rate); replaces one with the same id. */
  addTrack(id: number, channels: Float32Array[], startSeconds: number, options?: TrackOptions): void {
    const rate = this.sampleRate;
    if (rate) this.post({ type: "addTrack", id, channels, start: Math.round(startSeconds * rate), options });
  }

  removeTrack(id: number): void {
    this.post({ type: "removeTrack", id });
  }

  setTrack(id: number, options: TrackOptions): void {
    this.post({ type: "setTrack", id, options });
  }

  transport(action: TransportAction, seconds?: number): void {
    this.post({ type: "transport", action, seconds });
  }

  /** Starts a take where the playhead is (and plays), after `countIn` bars of clicks. */
  startRecording(includeDry: boolean, countIn = 0): void {
    this.takeChunks = [];
    this.post({ type: "record", on: true, dry: includeDry, countIn });
  }

  /** The click: on or off, its tempo, beats in a bar, level. */
  metronome(settings: { on?: boolean; bpm?: number; beatsPerBar?: number; volume?: number }): void {
    this.post({ type: "metronome", ...settings });
  }

  /** Ends the take; undefined when nothing was recording. */
  stopRecording(): Promise<RecordedTake | undefined> {
    if (!this.node) return Promise.resolve(undefined);
    if (this.takeDone) this.finishTake(undefined, undefined); // a stop still waiting
    const done = new Promise<RecordedTake | undefined>((resolve) => (this.takeDone = resolve));
    this.post({ type: "record", on: false });
    return done;
  }

  looper(command: LooperCommand): void {
    this.post({ type: "looper", command });
  }

  looperLayer(layer: number, options: { gain?: number; muted?: boolean }): void {
    this.post({ type: "looperLayer", layer, ...options });
  }

  looperSettings(options: { bpm?: number; beatsPerBar?: number; locked?: boolean; volume?: number }): void {
    this.post({ type: "looperSettings", ...options });
  }

  /** The raw mic in chunks of about 0.1 s (onMicChunk), for a sound check. */
  /** Loops from..to seconds on the tracks (Practice); without them, the loop ends. */
  loop(from?: number, to?: number): void {
    this.post({ type: "loop", from, to });
  }

  /** The Practice view's pitch tap: meters carry the mic's pitch readings while on. */
  pitch(on: boolean): void {
    this.post({ type: "pitch", on });
  }

  captureMic(on: boolean): void {
    this.post({ type: "captureMic", on });
  }

  /** A sound check's room profile for the denoiser; true when it took it. */
  offerNoiseProfile(bins: Float32Array): Promise<boolean> {
    if (!this.node || !bins.length) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.profileTaken = resolve;
      this.post({ type: "noiseProfile", bins });
    });
  }

  /** One pass of every looper layer (empty when stopped). */
  looperLayers(): Promise<{ layers: [Float32Array, Float32Array][]; sampleRate: number }> {
    if (!this.node) return Promise.resolve({ layers: [], sampleRate: 48000 });
    return new Promise((resolve) => {
      this.layersDone = resolve;
      this.post({ type: "looperExport" });
    });
  }

  private finishTake(start: number | undefined, frames: number | undefined) {
    const done = this.takeDone;
    if (!done) return;
    const chunks = this.takeChunks;
    const rate = this.sampleRate;
    this.takeDone = undefined;
    this.takeChunks = [];
    if (start === undefined || !frames || !rate) return done(undefined);

    const join = (parts: Float32Array[]) => {
      const out = new Float32Array(frames);
      let at = 0;
      for (const part of parts) {
        out.set(part.subarray(0, Math.min(part.length, frames - at)), at);
        at += part.length;
        if (at >= frames) break;
      }
      return out;
    };
    const dryParts = chunks.map((c) => c.dry).filter((d): d is Float32Array => d !== undefined);
    const backingParts = chunks.map((c) => c.backing).filter((b): b is [Float32Array, Float32Array] => b !== undefined);
    done({
      start: start / rate,
      seconds: frames / rate,
      sampleRate: rate,
      channels: [join(chunks.map((c) => c.channels[0])), join(chunks.map((c) => c.channels[1]))],
      dry: dryParts.length ? join(dryParts) : undefined,
      backing: backingParts.length ? [join(backingParts.map((b) => b[0])), join(backingParts.map((b) => b[1]))] : undefined,
    });
  }

  private post(message: ToWorklet) {
    this.node?.port.postMessage(message);
  }
}

const LATENCY_KEY = "micfx.latency";

function readLatencies(): Record<string, number> {
  try {
    return (JSON.parse(localStorage.getItem(LATENCY_KEY) ?? "{}") as Record<string, number>) ?? {};
  } catch {
    return {};
  }
}

function writeLatencies(all: Record<string, number>) {
  try {
    localStorage.setItem(LATENCY_KEY, JSON.stringify(all));
  } catch {
    // not kept
  }
}
