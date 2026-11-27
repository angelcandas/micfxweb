// The recorder's AudioWorkletProcessor: the mic's first channel, in blocks of 2048 frames.
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

const BLOCK = 2048;

class CaptureProcessor extends AudioWorkletProcessor {
  private block = new Float32Array(BLOCK);
  private filled = 0;

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let at = 0;
    while (at < channel.length) {
      const n = Math.min(BLOCK - this.filled, channel.length - at);
      this.block.set(channel.subarray(at, at + n), this.filled);
      this.filled += n;
      at += n;
      if (this.filled === BLOCK) {
        const out = this.block;
        this.port.postMessage(out, [out.buffer]);
        this.block = new Float32Array(BLOCK);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("micfx-capture", CaptureProcessor);
