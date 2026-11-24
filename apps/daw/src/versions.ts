// Autosave status and the Versions dialog (plan points 21 and 23). The engine (WebHistory.cpp)
// saves the project to the browser a second after each change, keeps a version every few
// minutes and on each save, and keeps the undo history across reloads.
import { el } from "./chooser";
import type { DawEngine } from "./engine";

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
export function addAutosaveStatus(engine: DawEngine) {
  const button = el("button", "web-saved", "Versions");
  button.type = "button";
  button.title = "Your work is kept in this browser a second after each change. Click to go back to an earlier version.";
  button.addEventListener("click", () => void showVersions(engine));
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
