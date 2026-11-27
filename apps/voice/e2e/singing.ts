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

/** A stereo "song": the sung voice in the middle and a pad off to the left, 16-bit at 44.1 kHz. */
export function stereoSongWav(seconds: number): Buffer {
  const mono = singingWav(seconds);
  const frames = (mono.length - 44) / 2;
  const data = Buffer.alloc(44 + frames * 4);
  mono.copy(data, 0, 0, 44);
  data.writeUInt16LE(2, 22); // channels
  data.writeUInt32LE(RATE * 4, 28);
  data.writeUInt16LE(4, 32);
  data.writeUInt32LE(36 + frames * 4, 4);
  data.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; ++i) {
    const voice = mono.readInt16LE(44 + i * 2) / 32767;
    const pad = 0.12 * Math.sin((2 * Math.PI * 165 * i) / RATE) + 0.08 * Math.sin((2 * Math.PI * 247 * i) / RATE);
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, voice + pad)) * 32767), 44 + i * 4);
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, voice - pad * 0.2)) * 32767), 46 + i * 4);
  }
  return data;
}
