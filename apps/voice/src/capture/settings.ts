import { el, sheet } from "./dom";
import type { CaptureSettings } from "./recorder";
import { keepStorage, storageLeft } from "./store";

const KEY = "micfx.capture.settings";

export function loadSettings(): CaptureSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<CaptureSettings>;
    return { preroll: saved.preroll ?? true, deviceId: saved.deviceId ?? "" };
  } catch {
    return { preroll: true, deviceId: "" };
  }
}

function save(settings: CaptureSettings) {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* a private window */ }
}

/** Input, pre-roll, and where the ideas are kept. Three choices and a link, nothing more. */
export async function openSettings(settings: CaptureSettings, changed: () => void): Promise<void> {
  let inputs: MediaDeviceInfo[] = [];
  try { inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" && d.deviceId); } catch { /* none */ }
  const select = el("select", { "aria-label": "Microphone", onchange: () => { settings.deviceId = select.value; save(settings); changed(); } },
    el("option", { value: "" }, "Automatic"),
    ...inputs.map((d, i) => el("option", { value: d.deviceId, selected: d.deviceId === settings.deviceId }, d.label || `Microphone ${i + 1}`)));
  const preroll = el("button", { type: "button", class: "chip", "aria-pressed": String(settings.preroll), onclick: () => {
    settings.preroll = !settings.preroll; save(settings); preroll.setAttribute("aria-pressed", String(settings.preroll)); preroll.textContent = settings.preroll ? "On" : "Off"; changed();
  } }, settings.preroll ? "On" : "Off");
  const left = await storageLeft();
  const kept = el("p", { class: "sheet-note" }, left !== undefined ? `About ${Math.round(left / 1e6 / 5.5)} minutes of recording space left on this device.` : "");
  const persist = el("button", { type: "button", class: "chip", onclick: async () => { persist.textContent = (await keepStorage()) ? "Ideas are kept" : "The browser decides"; } }, "Keep my ideas safe");
  const dialog = sheet("Capture settings",
    el("div", { class: "sheet-list" },
      el("label", { class: "sheet-row" }, el("span", {}, "Microphone"), select),
      el("div", { class: "sheet-row" }, el("span", {}, "Keep the 2 s before I tap"), preroll),
      el("div", { class: "sheet-row" }, el("span", {}, "Storage"), persist),
      el("a", { class: "sheet-row", href: "./?live=1" }, el("span", {}, "More audio settings, effects and Practice"), el("span", {}, "›"))),
    kept,
    el("p", { class: "sheet-note" }, "Ideas stay on this device. Recordings are 16-bit mono WAV. The mic is open only while this screen is showing, and a small dot says so."),
    el("button", { type: "button", class: "chip", onclick: () => dialog.close(), style: "margin-top:12px" }, "Done"));
}
