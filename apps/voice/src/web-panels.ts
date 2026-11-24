// The web's own parts of Settings, in the desktop's Settings window and its styles: share the
// sound as a link, back up and restore everything, and what this browser keeps (plan section
// 9, points 4 to 6). And a shared sound's link, opened.
import { type StoredItem, forgetFile, formatBytes, keepFiles, makeBackup, readBackup, storageReport } from "./backup";
import { readSoundHash, soundHash } from "./share";
import { TAKE_FORMATS, type TakeFormat, canEncodeOpus, setTakeFormat, takeFormat } from "./take-format";
import type { Tracks } from "./tracks";
import { download } from "./tracks";

export interface WebHooks {
  tracks: Tracks;
  sound(): { values: Record<string, number>; defaults: Record<string, number>; order: string[]; defaultOrder: string[] };
  applySound(values: Record<string, number>, order?: string[]): void;
  flush(): void;
  hold(): void;
}

function html<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function button(text: string, title: string, onClick: () => void, className = "tool"): HTMLButtonElement {
  const b = html("button", className, text);
  b.type = "button";
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** A short note at the foot of the window. */
export function toast(text: string) {
  let note = document.querySelector<HTMLDivElement>(".web-toast");
  if (!note) {
    note = html("div", "web-toast");
    note.setAttribute("role", "status");
    document.body.append(note);
  }
  note.textContent = text;
  note.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (note!.hidden = true), 5000);
}

function pickFile(accept: string): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept });
    input.addEventListener("change", () => resolve(input.files?.[0] ?? undefined), { once: true });
    input.addEventListener("cancel", () => resolve(undefined), { once: true });
    input.click();
  });
}

const today = () => new Date().toISOString().slice(0, 10);

/** Adds the web's sections to the desktop's Settings window (once it exists). */
export function addWebSettings(hooks: WebHooks) {
  const backdrop = document.querySelector<HTMLElement>(".settings-window");
  const body = backdrop?.querySelector<HTMLElement>(".setup-body");
  if (!backdrop || !body || body.querySelector(".web-settings")) return;
  // The desktop's AI control runs a server on the computer: there's none on the web.
  for (const heading of body.querySelectorAll("h3")) if (heading.textContent === "AI control") (heading.parentElement as HTMLElement).hidden = true;
  const section = (title: string, className: string) => {
    const element = html("section", `setup-section web-settings ${className}`);
    element.append(html("h3", "", title));
    body.append(element);
    return element;
  };
  const row = (parent: HTMLElement, label: string, ...controls: HTMLElement[]) => {
    const element = html("div", "setup-row");
    element.append(html("span", "setup-row-label", label), ...controls);
    parent.append(element);
    return element;
  };

  // The take's file, in the desktop's Recording section.
  const recording = [...body.querySelectorAll("h3")].find((h) => h.textContent === "Recording")?.parentElement;
  if (recording) {
    const select = html("select", "dropdown web-take-format");
    select.setAttribute("aria-label", "Take file format");
    for (const { id, label } of TAKE_FORMATS) select.append(new Option(label, id));
    select.value = takeFormat();
    select.addEventListener("change", () => setTakeFormat(select.value as TakeFormat));
    void canEncodeOpus().then((ok) => {
      const opus = select.querySelector<HTMLOptionElement>('option[value="opus"]');
      if (ok || !opus) return;
      opus.disabled = true;
      opus.textContent += " (not in this browser)";
      if (select.value === "opus") select.value = "wav";
    });
    const line = row(recording, "Take files", select);
    line.title = "What \"Show\" on a take downloads. Takes are kept as WAV in the browser either way.";
  }

  // Share
  const share = section("Share this sound", "web-share");
  const shareText = html("span", "setup-value", "A link with every effect's setting");
  row(
    share,
    "Link",
    shareText,
    button("Copy link", "Copies a link that opens this sound in anyone's browser: nothing is uploaded, the sound is in the link itself", async () => {
      const link = shareLink(hooks);
      try {
        await navigator.clipboard.writeText(link);
        shareText.textContent = "Copied: paste it anywhere";
      } catch {
        // no clipboard (or not allowed): the link to copy by hand
        window.prompt("Copy this link:", link);
      }
    }),
  );

  // Backup
  const backup = section("Backup", "web-backup");
  const backupText = html("span", "setup-value", "All your work in one file");
  const backupButton = button("Back up…", "Saves everything MicFX keeps in this browser as one .micfxbackup file", async () => {
    backupButton.disabled = true;
    backupText.textContent = "Packing…";
    try {
      hooks.flush();
      download(await makeBackup(), `MicFX Voice backup ${today()}.micfxbackup`);
      backupText.textContent = "Saved: keep the file somewhere safe";
    } catch (error) {
      backupText.textContent = `Couldn't back up: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      backupButton.disabled = false;
    }
  });
  const restoreButton = button("Restore…", "Opens a .micfxbackup file: this browser then has what it holds", async () => {
    const file = await pickFile(".micfxbackup,.zip,application/zip");
    if (!file) return;
    try {
      const { summary, restore } = await readBackup(file);
      const made = new Date(summary.made).toLocaleString();
      const ok = window.confirm(
        `Restore the backup from ${made}?\n\n${summary.tracks} tracks and takes, ${summary.songs} Practice songs, ${summary.settings} settings.\n\n` +
          "Your presets, sounds, setlist and tracks here are replaced by the backup's. Practice songs are added to the ones already here. The app then starts again.",
      );
      if (!ok) return;
      backupText.textContent = "Restoring…";
      hooks.hold();
      await restore();
      location.reload();
    } catch (error) {
      backupText.textContent = `Couldn't restore: ${error instanceof Error ? error.message : String(error)}`;
    }
  });
  row(backup, "Everything", backupText, backupButton, restoreButton);
  backup.append(html("p", "setup-note", "MicFX keeps your work in this browser only. A backup moves it to another computer or browser, or brings it back after the browser's data is cleared."));

  // Storage
  const storage = section("Storage", "web-storage");
  const usedText = html("span", "setup-value");
  const keepButton = button("Keep my files", "Asks the browser not to clear MicFX's files when the disk runs short", async () => {
    const kept = await keepFiles();
    toast(kept ? "The browser will keep MicFX's files." : "The browser said no: it decides by how much you use the site. Backups are the safe way.");
    void refresh();
  });
  row(storage, "This browser", usedText, keepButton);
  const keepNote = html("p", "setup-note");
  storage.append(keepNote);
  const list = html("div", "web-storage-list");
  storage.append(list);

  const forget = async (item: StoredItem) => {
    if (!window.confirm(`Delete "${item.name}" from this browser? It can't be undone (unless it's in a backup).`)) return;
    try {
      if (item.kind === "track" || item.kind === "take") await hooks.tracks.remove(Number(item.id));
      else {
        await forgetFile(item);
        if (item.kind === "practice" && practiceSong() === item.id) {
          location.reload(); // the open song is gone
          return;
        }
      }
      toast(`Deleted "${item.name}".`);
    } catch (error) {
      toast(`Couldn't delete it: ${error instanceof Error ? error.message : String(error)}`);
    }
    void refresh();
  };

  const KIND: Record<StoredItem["kind"], string> = { practice: "Practice", track: "Sing-along", take: "Take", setlist: "Setlist", model: "Splitter", settings: "Settings" };
  let refreshing = false;
  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const report = await storageReport();
      const total = report.items.reduce((sum, item) => sum + item.bytes, 0);
      usedText.textContent = report.quota ? `${formatBytes(report.used ?? total)} used of ${formatBytes(report.quota)} it allows` : `${formatBytes(total)} used`;
      keepButton.hidden = report.persisted;
      keepNote.textContent = report.persisted
        ? "Kept: the browser won't clear these files on its own. Clearing the site's data in the browser's settings still does."
        : "When the disk runs short, a browser may clear what sites keep, starting with the ones used least. \"Keep my files\" asks it not to; a backup is the sure way.";
      list.replaceChildren(
        ...report.items
          .sort((a, b) => b.bytes - a.bytes)
          .map((item) => {
            const line = html("div", "web-storage-item");
            line.dataset.kind = item.kind;
            line.append(html("span", "web-storage-kind", KIND[item.kind]), html("span", "web-storage-name", item.name), html("span", "web-storage-size", formatBytes(item.bytes)));
            if (item.removable) line.append(button("Delete", `Deletes "${item.name}" from this browser`, () => void forget(item), "tool web-storage-delete"));
            else line.append(html("span", "web-storage-delete"));
            return line;
          }),
      );
      if (!report.items.length) list.append(html("p", "setup-note", "Nothing kept yet."));
    } finally {
      refreshing = false;
    }
  };
  // Fresh numbers whenever Settings opens.
  new MutationObserver(() => {
    if (!backdrop.hidden) void refresh();
  }).observe(backdrop, { attributes: true, attributeFilter: ["hidden"] });
  if (!backdrop.hidden) void refresh();
}

function practiceSong(): string | undefined {
  try {
    return (JSON.parse(localStorage.getItem("micfx.practice") ?? "{}") as { folder?: string }).folder;
  } catch {
    return undefined;
  }
}

/** This page's address with the sound in it. */
export function shareLink(hooks: WebHooks): string {
  const { values, defaults, order, defaultOrder } = hooks.sound();
  const url = new URL(location.href);
  url.hash = soundHash(values, defaults, order, defaultOrder);
  return url.href;
}

/** A shared sound in the address plays, and the address is tidied (it's in the session now). */
export function openSharedSound(hooks: WebHooks): boolean {
  const { defaults } = hooks.sound();
  const sound = readSoundHash(location.hash, (id) => id in defaults);
  if (!sound) return false;
  hooks.applySound(sound.values, sound.order);
  history.replaceState(null, "", location.pathname + location.search);
  toast(sound.name ? `Opened the shared sound "${sound.name}".` : "Opened a shared sound.");
  return true;
}
