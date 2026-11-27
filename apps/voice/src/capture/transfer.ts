// Ideas going out (to MicFX DAW, or as files for a computer) and audio coming in.
import { sendToPartner, type HandoffItem } from "@micfx/handoff";
import { writeZip } from "../zip";
import { fileName, shareFile } from "./actions";
import { saveSamples } from "./make-idea";
import { readAudio, type Idea } from "./store";

export const isPhone = () => matchMedia("(max-width: 760px) and (pointer: coarse)").matches;

function unique(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : name.replace(/(\.[^.]+)?$/, ` ${n}$1`);
  });
}

/** Opens MicFX DAW with these ideas as audio tracks (on a tablet or a computer: a phone has no room for the DAW). */
export async function sendToDaw(ideas: Idea[]): Promise<{ ok: boolean; message?: string }> {
  const names = unique(ideas.map((i) => fileName(i)));
  const items: HandoffItem[] = await Promise.all(ideas.map(async (idea, i) => ({
    kind: "audio" as const, name: names[i]!, data: await (await readAudio(idea)).arrayBuffer(), role: "take" as const,
  })));
  return sendToPartner("voice", { from: "voice", items, title: "Ideas from MicFX Capture" });
}

/** The ideas as one .zip of WAV files, through the share sheet (AirDrop, Files, a cable...) or a download. */
export async function shareZip(ideas: Idea[]): Promise<void> {
  if (ideas.length === 1) {
    const only = ideas[0]!;
    return shareFile(new File([await readAudio(only)], fileName(only), { type: "audio/wav" }), only.name);
  }
  const names = unique(ideas.map((i) => fileName(i)));
  const zip = await writeZip(await Promise.all(ideas.map(async (idea, i) => ({ name: names[i]!, data: await readAudio(idea) }))));
  const stamp = new Date().toISOString().slice(0, 10);
  await shareFile(new File([zip], `MicFX ideas ${stamp}.zip`, { type: "application/zip" }), "MicFX ideas");
}

/** Audio files (a voice memo, a bounce) become ideas. */
export async function importFiles(files: File[]): Promise<{ added: Idea[]; failed: string[] }> {
  const added: Idea[] = [];
  const failed: string[] = [];
  for (const file of files) {
    try {
      const context = new OfflineAudioContext(1, 1, 48000);
      const buffer = await context.decodeAudioData(await file.arrayBuffer());
      const mono = new Float32Array(buffer.length);
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const data = buffer.getChannelData(c);
        for (let i = 0; i < mono.length; i++) mono[i] = mono[i]! + data[i]! / buffer.numberOfChannels;
      }
      added.push(await saveSamples(mono, buffer.sampleRate, { name: file.name.replace(/\.[^.]+$/, "") || "Imported", created: file.lastModified || Date.now() }));
    } catch {
      failed.push(file.name);
    }
  }
  return { added, failed };
}

/** Audio shared to MicFX from another app (Android's share sheet): picked up from the cache sw.js put it in. */
export async function takeShared(): Promise<File[]> {
  if (!("caches" in self)) return [];
  const cache = await caches.open("micfx-shared");
  const files: File[] = [];
  for (const request of await cache.keys()) {
    const response = await cache.match(request);
    if (response) files.push(new File([await response.blob()], decodeURIComponent(request.url.split("/").pop() ?? "shared"), { type: response.headers.get("content-type") ?? "" }));
    await cache.delete(request);
  }
  return files;
}
