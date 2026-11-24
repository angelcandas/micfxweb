// The audio side of MicFX Voice: the mic, the AudioContext and the engine's worklet.
import wasmUrl from "@micfx/engine/engine.wasm?url";
import workletUrl from "@micfx/engine/worklet?worker&url";
import type { FromWorklet, ToWorklet, Values } from "@micfx/engine/messages";
import { instantiateEngineModule, type FactoryPreset, type Meters, type ParameterInfo, type ValueInfo } from "@micfx/engine";

export interface LiveAudioInfo {
  values: ValueInfo[];
  parameters: Record<string, ParameterInfo>;
  presets: FactoryPreset[];
  order: string[];
  sampleRate: number;
}

let compiled: Promise<WebAssembly.Module> | undefined;

function compileEngine(): Promise<WebAssembly.Module> {
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
  const engine = instantiateEngineModule(await compileEngine()).create(48000, 128);
  const catalog = { parameters: engine.parameterInfo(), presets: engine.factoryPresets() };
  engine.dispose();
  return catalog;
}

/** Mic -> MicFX engine -> speakers/headphones. */
export class LiveAudio {
  onMeters: (meters: Meters) => void = () => {};
  /** Every parameter's value after a preset load. */
  onValues: (values: Values, order: string[]) => void = () => {};
  private context: AudioContext | undefined;
  private node: AudioWorkletNode | undefined;
  private stream: MediaStream | undefined;
  private latencySamples = 0;

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
        }
      };
    });

    context.createMediaStreamSource(this.stream).connect(node);
    node.connect(context.destination);
    await context.resume();
    return ready;
  }

  async stop(): Promise<void> {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.node?.disconnect();
    await this.context?.close().catch(() => {});
    this.stream = undefined;
    this.node = undefined;
    this.context = undefined;
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

  private post(message: ToWorklet) {
    this.node?.port.postMessage(message);
  }
}
