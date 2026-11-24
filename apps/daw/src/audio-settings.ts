// The DAW's "Audio settings…": the sample rate, the low latency switch and what the delay is
// made of, live. A new rate reloads the page (the engine is prepared at its rate); low
// latency changes at once. Export bit depth is in the desktop's Export dialog.
import { RATES, readAudioPrefs, writeAudioPrefs, type RatePref } from "@micfx/engine/audio-prefs";
import { el } from "./chooser";
import type { DawEngine } from "./engine";

const fmt = (v: number) => (v < 10 ? v.toFixed(1) : String(Math.round(v)));

export function showAudioSettings(engine: DawEngine, reload = () => location.reload()) {
  const prefs = readAudioPrefs();
  const backdrop = el("div", "web-dialog-backdrop");
  const dialog = el("div", "web-dialog web-audio-settings");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Audio settings");

  const row = (label: string, control: HTMLElement, hint: string) => {
    const line = el("label", "web-audio-row");
    line.append(el("span", "web-audio-label", label), control, el("span", "web-menu-hint", hint));
    return line;
  };

  const rate = el("select", "dropdown web-sample-rate");
  rate.setAttribute("aria-label", "Sample rate");
  for (const { value, label } of RATES) rate.append(new Option(label, String(value)));
  rate.value = String(prefs.rate);
  const now = engine.context?.sampleRate;

  const low = el("input", "web-low-latency");
  low.type = "checkbox";
  low.checked = prefs.lowLatency;
  low.setAttribute("aria-label", "Low latency");

  const delay = el("p", "web-dialog-note web-audio-delay");
  const parts = el("p", "web-dialog-note web-audio-parts");
  const note = el("p", "web-dialog-note",
    "Browsers can't use ASIO or other low latency drivers: they go through the system's own audio. On a Mac that's already quick; on Windows it's usually slower. Wired headphones help; Bluetooth adds 100 ms or more.");

  const render = () => {
    const p = engine.latencyParts();
    if (!p) {
      delay.textContent = "Start the sound (click anywhere) to see the delay.";
      parts.textContent = "";
      return;
    }
    const total = p.lead + p.backlog + p.base + p.output;
    delay.textContent = `About ${Math.round(total)} ms from the mic to your ears, plus the mic's own capture delay and any effects that add delay.`;
    parts.textContent = `Engine lead ${fmt(p.lead)} ms + mic waiting ${fmt(p.backlog)} ms + browser buffer ${fmt(p.base)} ms` +
      (p.output ? ` + output ${fmt(p.output)} ms` : "") + ` · ${p.rate / 1000} kHz · ${p.underruns} dropouts`;
  };
  render();
  const timer = window.setInterval(render, 500);

  const buttons = el("div", "web-dialog-buttons");
  const done = el("button", "web-dialog-primary", "Done");
  done.type = "button";
  buttons.append(el("span", "web-dialog-gap"), done);

  dialog.append(
    el("h2", "web-dialog-title", "Audio settings"),
    row("Sample rate", rate, now ? `Running at ${now / 1000} kHz. Match your interface to avoid resampling. Changing it reloads the DAW (your project is saved).` : "Match your interface to avoid resampling."),
    row("Low latency", low, "Renders just ahead of what you hear, and asks for the smallest buffers. It backs off by itself if the sound breaks up. Off is the safe setting for big projects."),
    delay,
    parts,
    note,
    buttons,
  );
  backdrop.append(dialog);
  document.body.append(backdrop);

  const finish = () => {
    window.clearInterval(timer);
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.stopPropagation(); finish(); }
  };
  document.addEventListener("keydown", onKey, true);
  low.addEventListener("change", () => {
    const next = { ...readAudioPrefs(), lowLatency: low.checked };
    writeAudioPrefs(next);
    engine.applyPrefs(next);
    render();
  });
  rate.addEventListener("change", () => {
    const next = { ...readAudioPrefs(), rate: Number(rate.value) as RatePref };
    writeAudioPrefs(next);
    if (engine.applyPrefs(next)) {
      rate.disabled = true;
      delay.textContent = "Reloading at the new rate…";
      // The autosave runs a second after a change; give the page a moment to flush.
      window.setTimeout(reload, 600);
    }
  });
  done.addEventListener("click", finish);
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) finish(); });
  done.focus();
}
