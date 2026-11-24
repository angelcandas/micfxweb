// The audio side of MicFX Voice: the mic, the AudioContext and the engine's worklet.
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
}

/** The meters with the transport and the recorder, as the worklet sends them. */
export type LiveMeters = Meters & { transport?: TransportState; recording?: number; status?: unknown; looper?: LooperState };

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
  /** Every parameter's value after a preset load. */
  onValues: (values: Values, order: string[]) => void = () => {};
  private context: AudioContext | undefined;
  private node: AudioWorkletNode | undefined;
  private stream: MediaStream | undefined;
  private latencySamples = 0;
  private outputId = "";
  private takeChunks: { channels: [Float32Array, Float32Array]; dry?: Float32Array }[] = [];
  private takeDone: ((take: RecordedTake | undefined) => void) | undefined;
  private layersDone: ((layers: { layers: [Float32Array, Float32Array][]; sampleRate: number }) => void) | undefined;

  get running(): boolean {
    return this.context?.state === "running";
  }

  /** Starts the engine and opens the mic. Call from a click (browsers need a gesture for sound). */
  async start(deviceId?: string): Promise<LiveAudioInfo> {
    await this.stop();
    const context = new AudioContext({ latencyHint: "interactive" });
    this.context = context;
    const [module] = await Promise.all([compileEngine(), context.audioWorklet.addModule(workletUrl)]);

    // The browser's own voice processing would fight the effects and add latency.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 1 },
      },
    });

    const node = new AudioWorkletNode(context, "micfx-live", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 1,
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
        } else if (message.type === "takeChunk") this.takeChunks.push({ channels: message.channels, dry: message.dry });
        else if (message.type === "takeEnd") this.finishTake(message.start, message.frames);
        else if (message.type === "looperLayers") {
          this.layersDone?.({ layers: message.layers, sampleRate: message.sampleRate });
          this.layersDone = undefined;
        }
      };
    });

    if (this.outputId) await this.setOutput(this.outputId).catch(() => {});
    context.createMediaStreamSource(this.stream).connect(node);
    node.connect(context.destination);
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
    await this.context?.close().catch(() => {});
    this.stream = undefined;
    this.node = undefined;
    this.context = undefined;
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
    const base = context.baseLatency || 128 / context.sampleRate;
    const output = context.outputLatency || 0;
    return (base * 2 + output + this.latencySamples / context.sampleRate) * 1000;
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

  /** Starts a take where the playhead is (and plays). */
  startRecording(includeDry: boolean): void {
    this.takeChunks = [];
    this.post({ type: "record", on: true, dry: includeDry });
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
    done({
      start: start / rate,
      seconds: frames / rate,
      sampleRate: rate,
      channels: [join(chunks.map((c) => c.channels[0])), join(chunks.map((c) => c.channels[1]))],
      dry: dryParts.length ? join(dryParts) : undefined,
    });
  }

  private post(message: ToWorklet) {
    this.node?.port.postMessage(message);
  }
}
