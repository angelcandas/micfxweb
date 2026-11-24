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
  private frames = 0;
  /** The monitoring path's own delay, summed over the blocks since the last report (frames):
   * what the engine had rendered ahead plus the mic still waiting in the input ring. */
  private leadSum = 0;
  private backlogSum = 0;
  private measured = 0;

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
      // Wakes the engine's audio thread at once: it renders the next block now.
      Atomics.notify(ints, r.outRead >> 2);
      this.leadSum += write - read;
      // (less the block written just now, which the engine takes for the block it renders next)
      this.backlogSum += Math.max(0, Atomics.load(ints, r.inWrite >> 2) - Atomics.load(ints, r.inRead >> 2) - BLOCK);
      this.measured++;
    } else {
      this.underruns++;
    }

    // Twice a second (in frames of this rate it's near enough): the underruns and the delay.
    this.frames += BLOCK;
    if (this.frames >= 24000) {
      this.frames = 0;
      const lead = this.measured ? this.leadSum / this.measured : 0;
      const backlog = this.measured ? this.backlogSum / this.measured : 0;
      this.leadSum = this.backlogSum = this.measured = 0;
      this.port.postMessage({ underruns: this.underruns, lead, backlog });
    }
    return true;
  }
}

registerProcessor("micfx-daw", DawProcessor);
