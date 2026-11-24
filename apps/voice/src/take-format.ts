// The file a take downloads as (plan section 9, point 7): the WAV it was recorded to, or an
// MP3 (the desktop's LAME, 192 kbps) or Opus (the browser's encoder, 128 kbps) copy, with
// the take's name and date inside. Takes stay WAV in the browser; this is only the download.
import mp3Url from "@micfx/engine/mp3.wasm?url";
import type { Mp3Reply, Mp3Request } from "./mp3-worker";
import Mp3Worker from "./mp3-worker?worker";
import { canEncodeOpus, encodeOggOpus } from "./ogg-opus";

export type TakeFormat = "wav" | "mp3" | "opus";
const KEY = "micfx.record.format";

export const TAKE_FORMATS: { id: TakeFormat; label: string }[] = [
  { id: "wav", label: "WAV (24-bit, as recorded)" },
  { id: "mp3", label: "MP3 (192 kbps)" },
  { id: "opus", label: "Opus (128 kbps, smallest)" },
];

export function takeFormat(): TakeFormat {
  try {
    const value = localStorage.getItem(KEY);
    return value === "mp3" || value === "opus" ? value : "wav";
  } catch {
    return "wav";
  }
}

export function setTakeFormat(format: TakeFormat) {
  try {
    localStorage.setItem(KEY, format);
  } catch {
    // not kept
  }
}

export { canEncodeOpus };

let mp3Module: Promise<WebAssembly.Module> | undefined;

export function encodeMp3File(channels: Float32Array[], rate: number, tags: { title?: string; year?: string; comment?: string }, quality = 2): Promise<Blob> {
  mp3Module ??= WebAssembly.compileStreaming(fetch(mp3Url)).catch(async () => WebAssembly.compile(await (await fetch(mp3Url)).arrayBuffer()));
  return mp3Module.then(
    (module) =>
      new Promise<Blob>((resolve, reject) => {
        const worker = new Mp3Worker();
        worker.onmessage = (event: MessageEvent<Mp3Reply>) => {
          worker.terminate();
          if (event.data.ok) resolve(new Blob([event.data.bytes as Uint8Array<ArrayBuffer>], { type: "audio/mpeg" }));
          else reject(new Error(event.data.error));
        };
        worker.onerror = (event) => {
          worker.terminate();
          reject(new Error(event.message || "The MP3 encoder stopped."));
        };
        worker.postMessage({ module, channels: channels.map((c) => c.slice()), rate, quality, tags } satisfies Mp3Request);
      }),
  );
}

/**
 * A take's file in `format`: `name` is its file name without the extension. Falls back to the
 * WAV when the browser can't make the format.
 */
export async function takeFile(wav: Blob, channels: Float32Array[], rate: number, name: string, format: TakeFormat, made = new Date()): Promise<{ blob: Blob; fileName: string }> {
  const comment = "Recorded with MicFX Voice";
  if (format === "mp3") return { blob: await encodeMp3File(channels, rate, { title: name, year: String(made.getFullYear()), comment }), fileName: `${name}.mp3` };
  if (format === "opus" && (await canEncodeOpus(Math.min(2, channels.length)))) {
    const date = made.toISOString().slice(0, 10);
    return { blob: await encodeOggOpus(channels, rate, { title: name, date, comment }), fileName: `${name}.opus` };
  }
  return { blob: wav, fileName: `${name}.wav` };
}
