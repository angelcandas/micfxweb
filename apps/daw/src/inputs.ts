// Which of the computer's audio inputs the DAW records from (plan point 26). Several devices
// (or one interface with many channels) give tracks several inputs to record at once; each
// track picks its input in its I/O, as on the desktop.
import { el } from "./chooser";
import type { DawEngine } from "./engine";

const STORE = "micfx.daw.inputs";

export function savedInputs(): string[] {
  try { return JSON.parse(localStorage.getItem(STORE) ?? "[]") as string[]; } catch { return []; }
}

function saveInputs(ids: string[]) {
  try { localStorage.setItem(STORE, JSON.stringify(ids)); } catch { /* private window */ }
}

/** Opens the inputs the person picked (or the default microphone). */
export async function connectSavedInputs(engine: DawEngine) {
  const saved = savedInputs();
  if (saved.length) {
    const present = new Set((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput").map((d) => d.deviceId));
    const ids = saved.filter((id) => present.has(id));
    if (ids.length) return engine.connectInput(ids);
  }
  return engine.connectInput();
}

export async function showInputs(engine: DawEngine, refresh: () => void) {
  // Device names show only once the page may use a microphone.
  if (!engine.inputChannels) await engine.connectInput();
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications");
  const chosen = new Set(savedInputs());

  const backdrop = el("div", "web-dialog-backdrop");
  const dialog = el("div", "web-dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Audio inputs");
  const list = el("div", "web-dialog-list web-midi-list");
  if (!devices.length) list.append(el("div", "web-dialog-empty", "No audio inputs, or the page may not use the microphone. Allow it in the browser's site settings."));
  for (const device of devices) {
    const line = el("label", "web-midi-row");
    const box = el("input");
    box.type = "checkbox";
    box.value = device.deviceId;
    box.checked = chosen.has(device.deviceId);
    line.append(box, el("span", "", device.label || "Microphone"), el("span", "web-menu-hint", "Its channels become inputs tracks can record from"));
    list.append(line);
  }
  const now = el("p", "web-dialog-note", engine.inputNames.length
    ? `Open now: ${engine.inputNames.map((name, i) => `${i + 1} ${name}`).join(" · ")}`
    : "No input is open yet.");
  const note = el("p", "web-dialog-note", "Pick one or more. Their channels follow each other (the first device's are inputs 1, 2…, the next one's come after, up to 16). Pick none for the browser's default microphone. Each track chooses its input in its I/O.");
  const cancel = el("button", "", "Cancel");
  cancel.type = "button";
  const ok = el("button", "web-dialog-primary", "Use these inputs");
  ok.type = "button";
  const buttons = el("div", "web-dialog-buttons");
  buttons.append(el("span", "web-dialog-gap"), cancel, ok);
  dialog.append(el("h2", "web-dialog-title", "Audio inputs"), list, now, note, buttons);
  backdrop.append(dialog);
  document.body.append(backdrop);

  return new Promise<void>((resolve) => {
    const finish = () => { backdrop.remove(); document.removeEventListener("keydown", onKey, true); resolve(); };
    const apply = async () => {
      const ids = [...list.querySelectorAll<HTMLInputElement>("input:checked")].map((box) => box.value);
      saveInputs(ids);
      ok.disabled = true;
      const opened = await engine.connectInput(ids.length ? ids : undefined);
      if (!opened) { note.textContent = "Couldn't open those inputs."; ok.disabled = false; return; }
      refresh();
      finish();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); finish(); }
      else if (event.key === "Enter") { event.stopPropagation(); event.preventDefault(); void apply(); }
    };
    document.addEventListener("keydown", onKey, true);
    cancel.addEventListener("click", finish);
    ok.addEventListener("click", () => void apply());
    backdrop.addEventListener("click", (event) => { if (event.target === backdrop) finish(); });
    ok.focus();
  });
}
