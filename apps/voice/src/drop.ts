// Drag and drop anywhere (plan section 9, point 29): files dropped on the page go where they
// belong, through the same steps as the buttons that open them.
// - A song (audio): in Practice, prepared as a song to sing (as "Open song…"); elsewhere, a
//   backing track (as "+ Backing track").
// - A .micfxset: opened as the setlist (as the setlist's "Open…").
// - An .lrc or text file in Practice: the song's lyrics.
// - A .micfxbackup: restored, after asking (as Settings › Restore…).
// - A shared sound's link (dragged from the address bar or a message): opened.
import { offerFile } from "./offered";

export interface DropHooks {
  addBackingTrack(file: File): Promise<unknown>;
  practice(action: string, options?: Record<string, unknown>): Promise<unknown>;
  hasPracticeSong(): boolean;
  openSoundLink(hash: string): boolean;
  notify(message: string, error?: boolean): void;
}

export type DropKind = "audio" | "setlist" | "lyrics" | "backup" | "unknown";

const AUDIO = /\.(wav|aiff?|flac|ogg|oga|opus|mp3|m4a|aac|webm|mp4|m4v|mov|3gp)$/i;

export function dropKind(file: { name: string; type: string }): DropKind {
  const name = file.name.toLowerCase();
  if (name.endsWith(".micfxset")) return "setlist";
  if (name.endsWith(".micfxbackup") || name.endsWith(".zip")) return "backup";
  if (name.endsWith(".lrc") || name.endsWith(".txt")) return "lyrics";
  if (AUDIO.test(name) || file.type.startsWith("audio/")) return "audio";
  return "unknown";
}

/** The "#sound=…" part of a dropped link, if it's a shared sound. */
export function soundHash(text: string): string | undefined {
  const match = /#sound=[^\s"'<>]+/.exec(text);
  return match?.[0];
}

const practiceOpen = () => {
  const section = document.querySelector<HTMLElement>("section.practice");
  return Boolean(section && !section.hidden && section.offsetParent !== null);
};

export function addDragAndDrop(hooks: DropHooks) {
  const overlay = Object.assign(document.createElement("div"), { className: "web-drop", hidden: true });
  overlay.setAttribute("aria-hidden", "true");
  const label = Object.assign(document.createElement("div"), { className: "web-drop-label" });
  overlay.append(label);
  document.body.append(overlay);
  let depth = 0;

  const carriesSomething = (event: DragEvent) => {
    const types = [...(event.dataTransfer?.types ?? [])];
    return types.includes("Files") || types.includes("text/uri-list") || types.includes("text/plain");
  };
  const hide = () => {
    depth = 0;
    overlay.hidden = true;
  };

  addEventListener("dragenter", (event) => {
    if (!carriesSomething(event)) return;
    // (a drop on a text field or the app's own drop areas stays theirs)
    if ((event.target as Element | null)?.closest?.("textarea, input")) return;
    depth++;
    label.textContent = practiceOpen() ? "Drop a song to practise, or its lyrics" : "Drop a song, a setlist, a backup or a sound's link";
    overlay.hidden = false;
  });
  addEventListener("dragleave", () => {
    if (--depth <= 0) hide();
  });
  addEventListener("dragover", (event) => {
    if (!carriesSomething(event) || (event.target as Element | null)?.closest?.("textarea, input")) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });
  addEventListener("drop", (event) => {
    if ((event.target as Element | null)?.closest?.("textarea, input")) return;
    hide();
    if (event.defaultPrevented) return; // an area of the app took it
    event.preventDefault();
    const files = [...(event.dataTransfer?.files ?? [])];
    const text = event.dataTransfer?.getData("text/uri-list") || event.dataTransfer?.getData("text/plain") || "";
    void take(files, text, hooks);
  });
}

async function take(files: File[], text: string, hooks: DropHooks) {
  if (!files.length) {
    const hash = soundHash(text);
    if (hash && hooks.openSoundLink(hash)) return;
    if (text) hooks.notify("That isn't something MicFX can open. Drop a song, a setlist, a backup or a shared sound's link.", true);
    return;
  }
  const inPractice = practiceOpen();
  let skipped = 0;
  let songs = 0;
  for (const file of files) {
    const kind = dropKind(file);
    if (kind === "audio" && inPractice) {
      // One song at a time in Practice: the first.
      if (songs++ === 0) {
        offerFile(file);
        await hooks.practice("open", { split: true });
      } else skipped++;
    } else if (kind === "audio") {
      await hooks.addBackingTrack(file);
    } else if (kind === "lyrics" && inPractice && hooks.hasPracticeSong()) {
      offerFile(file);
      await hooks.practice("importLyrics");
    } else if (kind === "setlist") {
      const drawer = document.querySelector<HTMLElement>(".setlist-drawer");
      if (drawer?.hidden) document.querySelector<HTMLElement>(".setlist-button")?.click();
      const open = document.querySelectorAll<HTMLButtonElement>(".setlist-files button")[1];
      if (!open) {
        skipped++;
        continue;
      }
      offerFile(file);
      open.click();
    } else if (kind === "backup") {
      const restore = document.querySelector<HTMLButtonElement>(".web-restore-button");
      if (!restore) {
        skipped++;
        continue;
      }
      offerFile(file);
      restore.click();
    } else skipped++;
  }
  if (skipped)
    hooks.notify(
      inPractice
        ? "Practice takes one song at a time, and its lyrics (.lrc or text) once a song is open."
        : `MicFX couldn't use ${skipped === 1 ? "one file" : `${skipped} files`}: drop songs, a .micfxset setlist or a .micfxbackup.`,
      true,
    );
}
