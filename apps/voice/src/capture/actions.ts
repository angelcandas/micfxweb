import { readAudio, type Idea } from "./store";

export function fileName(idea: Idea, extension = "wav"): string {
  return `${idea.name.replace(/[^\w .-]+/g, "_")}.${extension}`;
}

/** The phone's share sheet where there is one, else a download. */
export async function shareFile(file: File, title: string): Promise<void> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title }); return; } catch (error) { if ((error as DOMException).name === "AbortError") return; }
  }
  const url = URL.createObjectURL(file);
  const link = Object.assign(document.createElement("a"), { href: url, download: file.name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export async function shareIdea(idea: Idea): Promise<void> {
  const blob = await readAudio(idea);
  await shareFile(new File([blob], fileName(idea), { type: "audio/wav" }), idea.name);
}
