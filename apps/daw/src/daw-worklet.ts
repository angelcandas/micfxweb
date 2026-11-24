// The DAW's AudioWorkletProcessor: plays what the engine thread rendered and hands it the
// microphone, both through rings in the engine's shared memory (DawHost.cpp). It never waits:
// with nothing rendered yet it plays silence and counts an underrun.
import type { Rings } from "./protocol";

declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

const BLOCK = 128;

class DawProcessor extends AudioWorkletProcessor {
  private ints?: Int32Array;
  private floats?: Float32Array;
  private rings?: Rings;
  private underruns = 0;
  private reported = 0;
  private frames = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<{ memory: WebAssembly.Memory; rings: Rings }>) => {
      const buffer = event.data.memory.buffer;
      this.ints = new Int32Array(buffer);
      this.floats = new Float32Array(buffer);
      this.rings = event.data.rings;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const ints = this.ints, floats = this.floats, r = this.rings;
    const out = outputs[0];
    if (!ints || !floats || !r || !out) return true;

    // The microphone (or interface) into the input ring, when there's room.
    const input = inputs[0];
    const inWrite = Atomics.load(ints, r.inWrite >> 2);
    const inRead = Atomics.load(ints, r.inRead >> 2);
    if (input && input.length > 0 && r.inCapacity - (inWrite - inRead) >= BLOCK) {
      const base = r.inData >> 2;
      for (let i = 0; i < BLOCK; i++) {
        const frame = base + ((inWrite + i) % r.inCapacity) * r.inChannels;
        for (let ch = 0; ch < r.inChannels; ch++) floats[frame + ch] = input[ch]?.[i] ?? 0;
      }
      Atomics.store(ints, r.inWrite >> 2, inWrite + BLOCK);
    }

    // The engine's output.
    const write = Atomics.load(ints, r.outWrite >> 2);
    const read = Atomics.load(ints, r.outRead >> 2);
    if (write - read >= BLOCK) {
      const base = r.outData >> 2;
      for (let i = 0; i < BLOCK; i++) {
        const frame = base + ((read + i) % r.outCapacity) * r.outChannels;
        for (let ch = 0; ch < out.length; ch++) out[ch]![i] = floats[frame + Math.min(ch, r.outChannels - 1)]!;
      }
      Atomics.store(ints, r.outRead >> 2, read + BLOCK);
    } else {
      this.underruns++;
    }

    this.frames += BLOCK;
    if (this.frames >= 48000 && this.underruns !== this.reported) {
      this.frames = 0;
      this.reported = this.underruns;
      this.port.postMessage({ underruns: this.underruns });
    }
    return true;
  }
}

registerProcessor("micfx-daw", DawProcessor);
