// A plain .zip (stored, not compressed: the audio inside is already as small as it gets), so a
// backup opens in any unzip tool too. Files are read one at a time, never all at once.

export interface ZipEntry {
  name: string;
  data: Blob;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; ++n) {
    let c = n;
    for (let k = 0; k < 8; ++k) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; ++i) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

function dosTime(date: Date): { time: number; day: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    day: (Math.max(0, date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** The entries as one .zip. */
export async function writeZip(entries: ZipEntry[], date = new Date()): Promise<Blob> {
  const encoder = new TextEncoder();
  const { time, day } = dosTime(date);
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const size = entry.data.size;
    const crc = crc32(new Uint8Array(await entry.data.arrayBuffer()));
    const local = new DataView(new ArrayBuffer(30 + name.length));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    new Uint8Array(local.buffer).set(name, 30);
    parts.push(local.buffer, entry.data);

    const head = new DataView(new ArrayBuffer(46 + name.length));
    head.setUint32(0, 0x02014b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 20, true);
    head.setUint16(8, 0x0800, true);
    head.setUint16(10, 0, true);
    head.setUint16(12, time, true);
    head.setUint16(14, day, true);
    head.setUint32(16, crc, true);
    head.setUint32(20, size, true);
    head.setUint32(24, size, true);
    head.setUint16(28, name.length, true);
    head.setUint32(42, offset, true);
    new Uint8Array(head.buffer).set(name, 46);
    central.push(new Uint8Array(head.buffer));
    offset += 30 + name.length + size;
  }
  const centralSize = central.reduce((sum, c) => sum + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central.map((c) => c.buffer as ArrayBuffer), end.buffer], { type: "application/zip" });
}

/** A .zip's files (stored ones: what writeZip makes). Throws when it isn't one. */
export async function readZip(zip: Blob): Promise<ZipEntry[]> {
  const tailSize = Math.min(zip.size, 22 + 65535);
  const tail = new DataView(await zip.slice(zip.size - tailSize).arrayBuffer());
  let at = -1;
  for (let i = tailSize - 22; i >= 0; --i)
    if (tail.getUint32(i, true) === 0x06054b50) {
      at = i;
      break;
    }
  if (at < 0) throw new Error("This isn't a MicFX backup (or it's damaged).");
  const count = tail.getUint16(at + 10, true);
  const centralSize = tail.getUint32(at + 12, true);
  const centralAt = tail.getUint32(at + 16, true);
  const central = new DataView(await zip.slice(centralAt, centralAt + centralSize).arrayBuffer());
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let k = 0; k < count; ++k) {
    if (central.getUint32(p, true) !== 0x02014b50) throw new Error("This backup is damaged.");
    const method = central.getUint16(p + 10, true);
    const size = central.getUint32(p + 20, true);
    const nameLength = central.getUint16(p + 28, true);
    const extra = central.getUint16(p + 30, true);
    const comment = central.getUint16(p + 32, true);
    const offset = central.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(central.buffer, central.byteOffset + p + 46, nameLength));
    p += 46 + nameLength + extra + comment;
    if (method !== 0) throw new Error(`"${name}" is compressed: this backup wasn't made by MicFX.`);
    const local = new DataView(await zip.slice(offset, offset + 30).arrayBuffer());
    const start = offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    entries.push({ name, data: zip.slice(start, start + size) });
  }
  return entries;
}
