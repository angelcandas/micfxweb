// MicFX Capture: open, tap, record. A small page of its own (no effects engine): it starts
// fast and keeps every take safe on the device as it's recorded.
import { registerOffline } from "../update";
import { el } from "./dom";
import { ideasView } from "./ideas-view";
import { CaptureRecorder } from "./recorder";
import { recordView } from "./record-view";
import { openSettings, loadSettings } from "./settings";
import { recoverIdeas } from "./store";
import { importFiles, takeShared } from "./transfer";
import { toast } from "./dom";
import "./capture.css";

const recorder = new CaptureRecorder();
recorder.settings = loadSettings();

const params = new URLSearchParams(location.search);
type Tab = "record" | "ideas";

const app = document.getElementById("app")!;
const main = el("main", { class: "cap-main" });
const record = recordView({ recorder, saved: () => void ideas.reload(), openIdeas: () => show("ideas") });
const ideas = ideasView(() => show("record"), (idea) => { show("record"); record.layerOver(idea); });

const tabs: Record<Tab, HTMLButtonElement> = {
  record: el("button", { type: "button", class: "cap-tab", role: "tab", onclick: () => show("record") }, el("b", { "aria-hidden": "true" }, "●"), "Record"),
  ideas: el("button", { type: "button", class: "cap-tab", role: "tab", onclick: () => show("ideas") }, el("b", { "aria-hidden": "true" }, "♪"), "Ideas"),
};

function show(tab: Tab) {
  main.replaceChildren(tab === "record" ? record.root : ideas.root);
  for (const [name, button] of Object.entries(tabs)) button.setAttribute("aria-selected", String(name === tab));
  if (tab === "ideas") void ideas.reload();
  else ideas.stopPlaying();
  history.replaceState(null, "", tab === "ideas" ? "#ideas" : location.pathname + location.search.replace(/[?&]record=1/, ""));
}

app.className = "cap";
app.append(
  el("header", { class: "cap-top" }, el("h1", {}, "MicFX Capture"),
    el("button", { type: "button", class: "icon-btn", "aria-label": "Settings", onclick: () => void openSettings(recorder.settings, () => { if (recorder.state === "open" && !recorder.recording) { recorder.close(); void arm(); } }) }, "⚙")),
  main,
  el("nav", { class: "cap-tabs", role: "tablist", "aria-label": "Capture" }, tabs.record, tabs.ideas,
    el("a", { class: "cap-tab", href: "./?live=1" }, el("b", { "aria-hidden": "true" }, "≋"), "Live & Practice")));

/** The mic is allowed already: open it so the 2 s before a tap are kept. */
async function arm() {
  if (!recorder.settings.preroll || recorder.state === "open" || recorder.state === "opening") return;
  try {
    const status = await navigator.permissions?.query({ name: "microphone" as PermissionName });
    if (status?.state === "granted") await recorder.open();
  } catch { /* Safari doesn't say: the first tap opens the mic */ }
}

// A browser starts audio only after a touch: the first one wakes the mic.
addEventListener("pointerdown", () => { if (recorder.state === "open" && !recorder.running) void recorder.open(); }, { passive: true });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { if (!recorder.recording && recorder.state !== "closed") recorder.close(); }
  else void arm();
});

void (async () => {
  await recoverIdeas().catch(() => {});
  show(location.hash === "#ideas" ? "ideas" : "record");
  // Audio shared to MicFX from another app.
  if (params.has("shared")) {
    const files = await takeShared().catch(() => []);
    const { added, failed } = await importFiles(files);
    history.replaceState(null, "", location.pathname);
    show("ideas");
    toast(failed.length ? `Couldn't read ${failed.join(", ")}.` : `Added ${added.length} shared idea${added.length === 1 ? "" : "s"}.`);
  }
  await arm();
  // From the home-screen shortcut: record at once (where the browser lets audio start).
  if (params.get("record") === "1") {
    await record.start();
  }
  if (import.meta.env.PROD) registerOffline(() => recorder.recording);
})();
