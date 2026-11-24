// Takes as Opus in an Ogg file (.opus), encoded by the browser's own Opus encoder (WebCodecs:
// Chrome, Edge and Firefox; not every Safari). The Ogg pages are written here (RFC 7845).

const OPUS_RATE = 48000;

/** Whether this browser can encode Opus. */
export async function canEncodeOpus(channels = 2): Promise<boolean> {
  if (typeof AudioEncoder === "undefined") return false;
  try {
    return Boolean((await AudioEncoder.isConfigSupported({ codec: "opus", sampleRate: OPUS_RATE, numberOfChannels: channels, bitrate: 128_000 })).supported);
  } catch {
    return false;
  }
}

export interface OpusTags {
  title?: string;
  date?: string;
  comment?: string;
}

/** One or two channels as an Ogg Opus file. */
export async function encodeOggOpus(input: Float32Array[], rate: number, tags: OpusTags = {}, bitrate = 128_000): Promise<Blob> {
  const channels = await to48k(input.slice(0, 2), rate);
  const count = channels.length;
  const frames = channels[0]?.length ?? 0;
  const packets: { data: Uint8Array; samples: number }[] = [];
  let failure: Error | undefined;
  let preSkip = 312; // libopus's usual look-ahead at 48 kHz, unless the encoder says
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      const description = metadata?.decoderConfig?.description;
      if (description && description.byteLength >= 12) {
        const head = ArrayBuffer.isView(description) ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength) : new Uint8Array(description as ArrayBuffer);
        if (new TextDecoder().decode(head.subarray(0, 8)) === "OpusHead") preSkip = head[10]! | (head[11]! << 8);
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      packets.push({ data, samples: Math.round(((chunk.duration ?? 20_000) * OPUS_RATE) / 1e6) });
    },
    error: (error) => (failure = error instanceof Error ? error : new Error(String(error))),
  });
  encoder.configure({ codec: "opus", sampleRate: OPUS_RATE, numberOfChannels: count, bitrate });
  const block = OPUS_RATE; // a second at a time
  for (let from = 0; from < frames; from += block) {
    const n = Math.min(block, frames - from);
    const planar = new Float32Array(n * count);
    for (let c = 0; c < count; ++c) planar.set(channels[c]!.subarray(from, from + n), c * n);
    const data = new AudioData({ format: "f32-planar", sampleRate: OPUS_RATE, numberOfFrames: n, numberOfChannels: count, timestamp: Math.round((from * 1e6) / OPUS_RATE), data: planar });
    encoder.encode(data);
    data.close();
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  return new Blob(oggPages(packets, count, preSkip, frames, tags) as BlobPart[], { type: "audio/ogg; codecs=opus" });
}

async function to48k(channels: Float32Array[], rate: number): Promise<Float32Array[]> {
  if (rate === OPUS_RATE || !channels[0]?.length) return channels;
  const frames = Math.ceil((channels[0].length * OPUS_RATE) / rate);
  const context = new OfflineAudioContext(channels.length, frames, OPUS_RATE);
  const buffer = context.createBuffer(channels.length, channels[0].length, rate);
  channels.forEach((channel, c) => buffer.copyToChannel(channel as Float32Array<ArrayBuffer>, c));
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  const out = await context.startRendering();
  return channels.map((_, c) => out.getChannelData(c).slice());
}

// ----- Ogg ---------------------------------------------------------------------------------

const OGG_CRC = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; ++i) {
    let r = i << 24;
    for (let k = 0; k < 8; ++k) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

export function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) ^ b) & 0xff]!) >>> 0;
  return crc;
}

function page(packet: Uint8Array, serial: number, sequence: number, granule: bigint, flags: number): Uint8Array {
  const lacing: number[] = [];
  for (let left = packet.length; ; left -= 255) {
    lacing.push(Math.min(255, left));
    if (left < 255) break;
  }
  if (lacing.length > 255) throw new Error("An Opus packet too big for one Ogg page.");
  const out = new Uint8Array(27 + lacing.length + packet.length);
  const view = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53]); // "OggS"
  view.setUint8(4, 0);
  view.setUint8(5, flags);
  view.setBigUint64(6, granule, true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  view.setUint8(26, lacing.length);
  out.set(lacing, 27);
  out.set(packet, 27 + lacing.length);
  view.setUint32(22, oggCrc(out), true);
  return out;
}

/** The pages of an Ogg Opus stream: the head, the tags, then one packet a page. */
export function oggPages(packets: { data: Uint8Array; samples: number }[], channels: number, preSkip: number, frames: number, tags: OpusTags = {}): Uint8Array[] {
  const serial = (Math.random() * 0xffffffff) >>> 0;
  const head = new Uint8Array(19);
  const headView = new DataView(head.buffer);
  head.set(new TextEncoder().encode("OpusHead"));
  head[8] = 1;
  head[9] = channels;
  headView.setUint16(10, preSkip, true);
  headView.setUint32(12, OPUS_RATE, true);
  headView.setInt16(16, 0, true);
  head[18] = 0;

  const encoder = new TextEncoder();
  const vendor = encoder.encode("MicFX Voice");
  const comments = [tags.title && `TITLE=${tags.title}`, tags.date && `DATE=${tags.date}`, tags.comment && `COMMENT=${tags.comment}`].filter(Boolean).map((c) => encoder.encode(c as string));
  const tagBytes = new Uint8Array(8 + 4 + vendor.length + 4 + comments.reduce((sum, c) => sum + 4 + c.length, 0));
  const tagView = new DataView(tagBytes.buffer);
  tagBytes.set(encoder.encode("OpusTags"));
  let at = 8;
  tagView.setUint32(at, vendor.length, true);
  tagBytes.set(vendor, (at += 4));
  tagView.setUint32((at += vendor.length), comments.length, true);
  at += 4;
  for (const c of comments) {
    tagView.setUint32(at, c.length, true);
    tagBytes.set(c, (at += 4));
    at += c.length;
  }

  const pages = [page(head, serial, 0, 0n, 0x02), page(tagBytes, serial, 1, 0n, 0)];
  // The last page's granule is the real end (pre-skip plus the audio), so players trim the
  // encoder's padding.
  const end = BigInt(preSkip + frames);
  let granule = 0n;
  packets.forEach((packet, i) => {
    granule += BigInt(packet.samples);
    const last = i === packets.length - 1;
    pages.push(page(packet.data, serial, i + 2, last && granule > end ? end : granule, last ? 0x04 : 0));
  });
  return pages;
}
