// A 16-bit mono WAV, written as the recording goes: the header is rewritten with every
// write, so the file on disk is always a valid WAV, even if the page dies mid-take.

export const WAV_HEADER = 44;

export function wavHeader(rate: number, frames: number): Uint8Array {
  const bytes = frames * 2;
  const buffer = new ArrayBuffer(WAV_HEADER);
  const v = new DataView(buffer);
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  text(0, "RIFF"); v.setUint32(4, 36 + bytes, true); text(8, "WAVE"); text(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  text(36, "data"); v.setUint32(40, bytes, true);
  return new Uint8Array(buffer);
}

export function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** The samples of a WAV written by this app (16-bit mono) as floats. */
export function readSamples(wav: ArrayBuffer): { samples: Float32Array; rate: number } {
  const v = new DataView(wav);
  const rate = v.getUint32(24, true);
  const count = Math.floor((wav.byteLength - WAV_HEADER) / 2);
  const ints = new Int16Array(wav, WAV_HEADER, count);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) samples[i] = ints[i]! / 0x8000;
  return { samples, rate };
}
