// A song to practise with, made in the test.

const RATE = 44100;

/** A sung melody: five notes of two seconds with pauses between, as a 16-bit WAV. */
export function singingWav(seconds: number): Buffer {
  const frames = Math.round(seconds * RATE);
  const data = Buffer.alloc(44 + frames * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + frames * 2, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(RATE, 24);
  data.writeUInt32LE(RATE * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(frames * 2, 40);
  const notes = [220, 247, 262, 196, 233];
  let phase = 0;
  for (let i = 0; i < frames; ++i) {
    const t = i / RATE;
    const inPhrase = t % 3.2;
    let voice = 0;
    if (inPhrase < 2) {
      const f = notes[Math.floor(t / 3.2) % notes.length]! * (1 + 0.012 * Math.sin(2 * Math.PI * 5.5 * t));
      phase += (2 * Math.PI * f) / RATE;
      const env = Math.min(1, inPhrase / 0.05, (2 - inPhrase) / 0.1);
      for (let h = 1; h <= 12; ++h) voice += Math.sin(phase * h) / (h * (h > 3 ? 1.5 : 1));
      voice *= 0.25 * env;
    }
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(voice * 32767))), 44 + i * 2);
  }
  return data;
}
