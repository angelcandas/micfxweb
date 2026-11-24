// The AudioWorkletProcessor that runs the MicFX engine on the browser's audio thread.
//
// The page compiles engine.wasm once and passes the WebAssembly.Module in processorOptions;
// the processor instantiates it synchronously here. Messages from the page set values,
// the order or a whole preset; meters go back about 30 times a second.
import { instantiateEngineModule, type LiveEngine } from "./engine";
import type { ToWorklet, FromWorklet } from "./messages";
import { Session, type TakeChunk } from "./session";

// AudioWorkletGlobalScope's own globals (not in the DOM lib).
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

const METER_INTERVAL_SECONDS = 1 / 30;

class MicFxProcessor extends AudioWorkletProcessor {
  private engine: LiveEngine | undefined;
  private nextMeterFrame = 0;
  private silent = new Float32Array(128);
  private parameterIds: string[] = [];
  private wantsStatus = false;
  private session = new Session(sampleRate, (chunk: TakeChunk) => {
    const message: FromWorklet = { type: "takeChunk", ...chunk };
    const transfer = [chunk.channels[0].buffer, chunk.channels[1].buffer, ...(chunk.dry ? [chunk.dry.buffer] : [])];
    this.port.postMessage(message, transfer as ArrayBuffer[]);
  });

  constructor(options: { processorOptions: { module: WebAssembly.Module } }) {
    super();
    try {
      const engine = instantiateEngineModule(options.processorOptions.module).create(sampleRate, 128);
      this.engine = engine;
      this.parameterIds = Object.keys(engine.parameterInfo());
      const ready: FromWorklet = {
        type: "ready",
        values: engine.valueInfo(),
        parameters: engine.parameterInfo(),
        presets: engine.factoryPresets(),
        order: engine.getOrder(),
        sampleRate,
      };
      this.port.postMessage(ready);
    } catch (error) {
      const failed: FromWorklet = { type: "error", message: String(error) };
      this.port.postMessage(failed);
    }
    this.port.onmessage = (event: MessageEvent<ToWorklet>) => this.handle(event.data);
  }

  private handle(message: ToWorklet) {
    const engine = this.engine;
    if (!engine) return;
    switch (message.type) {
      case "set":
        for (const [id, value] of Object.entries(message.values)) engine.setValue(id, value);
        break;
      case "preset":
        engine.resetValues();
        for (const [id, value] of Object.entries(message.values)) engine.setValue(id, value);
        engine.setOrder(message.order ?? []);
        break;
      case "order":
        engine.setOrder(message.keys);
        break;
      case "status":
        this.wantsStatus = message.on;
        break;
      case "loadPreset":
        if (engine.loadPreset(message.index)) this.sendValues();
        break;
      case "addTrack":
        this.session.addTrack(message.id, message.channels, message.start, message.options);
        break;
      case "removeTrack":
        this.session.removeTrack(message.id);
        break;
      case "setTrack":
        this.session.setTrack(message.id, message.options);
        break;
      case "transport":
        this.session.transport(message.action, message.seconds);
        break;
      case "record": {
        if (message.on) {
          this.session.startRecording(Boolean(message.dry));
          break;
        }
        const end: FromWorklet = { type: "takeEnd", ...this.session.stopRecording() };
        this.port.postMessage(end);
        break;
      }
    }
  }

  private sendValues() {
    const engine = this.engine!;
    const values: Record<string, number> = {};
    for (const id of this.parameterIds) values[id] = engine.getValue(id) ?? 0;
    const message: FromWorklet = { type: "values", values, order: engine.getOrder() };
    this.port.postMessage(message);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const engine = this.engine;
    const out = outputs[0];
    if (!engine || !out || out.length === 0) return true;

    const mic = inputs[0]?.[0] ?? this.silent;
    const left = out[0]!;
    const right = out[1] ?? left;
    engine.render(mic, left, right);
    this.session.process(left, right, mic, Math.min(mic.length, left.length));

    if (currentFrame >= this.nextMeterFrame) {
      this.nextMeterFrame = currentFrame + METER_INTERVAL_SECONDS * sampleRate;
      const session = this.session;
      const meters: FromWorklet = {
        type: "meters",
        ...engine.takeMeters(),
        transport: { position: session.position / sampleRate, length: session.length / sampleRate, playing: session.playing },
        recording: session.recordingSeconds,
        ...(this.wantsStatus ? { status: engine.status() } : {}),
      };
      this.port.postMessage(meters);
    }
    return true;
  }
}

registerProcessor("micfx-live", MicFxProcessor);
