// Writes a recording to a file in the browser's private storage (OPFS) as it comes in.
// A sync access handle is the one way every browser (Safari too) can append to such a file.
import { WAV_HEADER, wavHeader } from "./wav";

export type WriterRequest =
  | { t: "open"; id: string; rate: number }
  | { t: "pcm"; pcm: Int16Array }
  | { t: "close" };
export type WriterReply = { t: "opened" } | { t: "unsupported"; why: string } | { t: "closed"; frames: number };

let handle: { write(data: ArrayBufferView, options?: { at: number }): number; flush(): void; close(): void } | undefined;
let rate = 48000;
let frames = 0;
let lastFlush = 0;

const reply = (message: WriterReply) => self.postMessage(message);

self.onmessage = async (event: MessageEvent<WriterRequest>) => {
  const m = event.data;
  try {
    if (m.t === "open") {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("ideas", { create: true });
      const file = await dir.getFileHandle(`${m.id}.wav`, { create: true });
      const create = (file as unknown as { createSyncAccessHandle?: () => Promise<typeof handle> }).createSyncAccessHandle;
      if (!create) return reply({ t: "unsupported", why: "no sync access handle" });
      handle = await create.call(file);
      rate = m.rate;
      frames = 0;
      handle!.write(wavHeader(rate, 0), { at: 0 });
      reply({ t: "opened" });
    } else if (m.t === "pcm" && handle) {
      handle.write(m.pcm, { at: WAV_HEADER + frames * 2 });
      frames += m.pcm.length;
      handle.write(wavHeader(rate, frames), { at: 0 });
      if (Date.now() - lastFlush > 1000) { handle.flush(); lastFlush = Date.now(); }
    } else if (m.t === "close" && handle) {
      handle.write(wavHeader(rate, frames), { at: 0 });
      handle.flush();
      handle.close();
      handle = undefined;
      reply({ t: "closed", frames });
    }
  } catch (error) {
    reply({ t: "unsupported", why: String(error) });
  }
};
