// Autosave status and the Versions dialog (plan points 21 and 23). The engine (WebHistory.cpp)
// saves the project to the browser a second after each change, keeps a version every few
// minutes and on each save, and keeps the undo history across reloads.
import { el } from "./chooser";
import type { DawEngine } from "./engine";
import { canSaveToFolder, downloadProject, saveToFolder } from "./projects";

interface Version { id: string; time: number; saved: boolean }
interface History { savedAt: number; path: string; unsaved: boolean; versions: Version[] }

const history = (engine: DawEngine, args: unknown[] = []) => engine.call("webHistory", args) as Promise<History>;

function when(time: number) {
  const date = new Date(time);
  const today = new Date();
  const clock = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return `Today ${clock}`;
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${clock}`;
  return `${date.toLocaleDateString([], { day: "numeric", month: "short" })} ${clock}`;
}

/** "Saved just now" next to the project name, which opens the versions. */
export interface MenuItem { label: string; hint: string; action: () => Promise<unknown> }

export function addAutosaveStatus(engine: DawEngine, extras: MenuItem[] = []) {
  const button = el("button", "web-saved", "Versions");
  button.type = "button";
  button.title = "Your work is kept in this browser a second after each change. Click for versions, and to take the project to your computer.";
  button.setAttribute("aria-haspopup", "menu");
  button.addEventListener("click", () => openMenu(engine, button, (text) => { button.textContent = text; }, extras));
  const place = document.querySelector(".app-project");
  place?.append(el("span", "web-saved-dot", " · "), button);

  let savedAt = 0;
  const refresh = () => {
    if (!savedAt) return;
    const seconds = Math.round((Date.now() - savedAt) / 1000);
    button.textContent = seconds < 5 ? "Saved just now" : `Saved ${seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`} ago`;
  };
  setInterval(refresh, 5000);
  return {
    saved(time: number) { savedAt = time; refresh(); },
    say(text: string) { button.textContent = text; },
  };
}

/** The versions to go back to: every few minutes of work, and each save. */
export async function showVersions(engine: DawEngine) {
  const { versions } = await history(engine, ["flush"]);
  return new Promise<void>((resolve) => {
    let selected: Version | undefined;
    const backdrop = el("div", "web-dialog-backdrop");
    const dialog = el("div", "web-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Versions");
    const list = el("div", "web-dialog-list");
    list.setAttribute("role", "listbox");
    const note = el("p", "web-dialog-note",
      "Your work is saved in this browser a second after each change, with its undo history. A version is kept every few minutes and each time you save (the last 20). Going back keeps what you have now as a version too.");
    const cancel = el("button", "", "Close");
    cancel.type = "button";
    const ok = el("button", "web-dialog-primary", "Go back to this version");
    ok.type = "button";
    ok.disabled = true;
    const buttons = el("div", "web-dialog-buttons");
    buttons.append(el("span", "web-dialog-gap"), cancel, ok);
    dialog.append(el("h2", "web-dialog-title", "Versions"), list, note, buttons);
    backdrop.append(dialog);
    document.body.append(backdrop);

    list.replaceChildren(...(versions.length ? versions.map((version) => {
      const row = el("button", "web-dialog-row");
      row.type = "button";
      row.setAttribute("role", "option");
      row.append(el("span", "web-dialog-icon", version.saved ? "💾" : "🕘"), el("span", "web-dialog-file", when(version.time)),
        el("span", "web-dialog-size", version.saved ? "Saved" : "Autosaved"));
      row.addEventListener("click", () => {
        selected = version;
        ok.disabled = false;
        for (const other of list.children) other.classList.toggle("is-selected", other === row);
      });
      row.addEventListener("dblclick", () => void restore());
      return row;
    }) : [el("div", "web-dialog-empty", "No versions yet: one is kept after a few minutes of work, and each time you save.")]));

    const finish = () => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve();
    };
    const restore = async () => {
      if (!selected) return;
      const result = (await history(engine, ["restore", selected.id])) as unknown as { ok: boolean; error?: string };
      if (!result.ok) { note.textContent = result.error ?? "Couldn't go back to that version."; return; }
      finish();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); finish(); }
      else if (event.key === "Enter") { event.stopPropagation(); event.preventDefault(); void restore(); }
    };
    document.addEventListener("keydown", onKey, true);
    cancel.addEventListener("click", finish);
    ok.addEventListener("click", () => void restore());
    backdrop.addEventListener("click", (event) => { if (event.target === backdrop) finish(); });
    cancel.focus();
  });
}

/** Writes what's waiting when the tab is hidden or closed (best effort). */
export function flushOnHide(engine: DawEngine) {
  const flush = () => void history(engine, ["flush"]).catch(() => {});
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
  window.addEventListener("pagehide", flush);
}

/** The project's place: versions, and the project as a desktop project on the computer. */
function openMenu(engine: DawEngine, anchor: HTMLElement, say: (text: string) => void, extras: MenuItem[]) {
  document.querySelector(".web-menu")?.remove();
  const menu = el("div", "web-menu");
  menu.setAttribute("role", "menu");
  const box = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(box.left, innerWidth - 300))}px`;
  menu.style.top = `${box.bottom + 6}px`;
  const close = () => { menu.remove(); document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", onKey, true); };
  const away = (event: Event) => { if (!menu.contains(event.target as Node)) close(); };
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); close(); } };
  const item = (label: string, hint: string, action: () => Promise<unknown>) => {
    const row = el("button", "web-menu-item");
    row.type = "button";
    row.setAttribute("role", "menuitem");
    row.append(el("span", "", label), el("span", "web-menu-hint", hint));
    row.addEventListener("click", () => {
      close();
      action().catch((error) => say(error instanceof Error ? error.message : String(error)));
    });
    menu.append(row);
  };
  item("Versions…", "Go back to an earlier version of this project", () => showVersions(engine));
  item("Download project (.micfxproj)", "One file with the project and its audio: open it here or in the desktop app", async () => {
    say("Packing the project…");
    await downloadProject(engine);
    say("Project downloaded");
  });
  if (canSaveToFolder())
    item("Save to a folder on your computer…", "As a desktop project folder (Name.micfx) that MicFX on your computer opens", async () => {
      const saved = await saveToFolder(engine);
      if (saved) say(`Saved as ${saved}`);
    });
  for (const extra of extras) item(extra.label, extra.hint, extra.action);
  document.body.append(menu);
  document.addEventListener("pointerdown", away, true);
  document.addEventListener("keydown", onKey, true);
  (menu.firstElementChild as HTMLElement | null)?.focus();
}
