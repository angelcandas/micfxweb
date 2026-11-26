import { drawBars, el, formatTime, toast } from "./dom";
import { analyse } from "./analyze";
import type { CaptureRecorder } from "./recorder";
import { getIdea, keepStorage, readAudio, saveIdea, type Idea } from "./store";

export interface RecordHooks {
  recorder: CaptureRecorder;
  /** An idea was saved: the Ideas list refreshes. */
  saved(idea: Idea): void;
  openIdeas(): void;
}

/** The Record screen: one button, a timer, a waveform. */
export function recordView(hooks: RecordHooks): { root: HTMLElement; refresh(): void; start(): Promise<void>; stop(): Promise<void> } {
  const { recorder } = hooks;
  const root = el("section", { class: "rec", "aria-label": "Record" });
  const dot = el("span", { class: "rec-dot", "aria-hidden": "true" });
  const micText = el("span", {}, "");
  const wave = el("canvas", { class: "rec-wave", "aria-hidden": "true" });
  const time = el("div", { class: "rec-time", role: "timer", "aria-live": "off" }, "0:00.0");
  const hint = el("div", { class: "rec-hint", "aria-live": "polite" }, "");
  const button = el("button", { type: "button", class: "rec-button", "aria-label": "Record" }, el("span", {}, "Record"));
  const mark = el("button", { type: "button", class: "rec-side", hidden: true, "aria-label": "Mark this moment", onclick: () => {
    const at = recorder.mark();
    navigator.vibrate?.(15);
    hint.textContent = `Marked at ${formatTime(at, false)}`;
  } }, "Mark");
  const spacer = el("span", { class: "rec-side", style: "visibility:hidden", "aria-hidden": "true" });
  const last = el("div", { class: "rec-last" });
  root.append(
    el("div", { class: "rec-mic" }, dot, micText), wave, time, hint,
    el("div", { class: "rec-actions" }, spacer, button, mark), last);

  let level = 0;
  let timer = 0;
  let wakeLock: { release(): Promise<void> } | undefined;
  let raf = 0;
  let live: number[] = [];

  async function lock() {
    try { wakeLock = await (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock?.request("screen"); } catch { /* not allowed */ }
  }
  const unlock = () => { void wakeLock?.release().catch(() => {}); wakeLock = undefined; };

  recorder.onLevel = (peak) => { level = Math.max(peak, level * 0.85); };
  recorder.onBar = (bar) => { live.push(Math.round(Math.min(1, Math.sqrt(bar)) * 100)); };

  const draw = () => {
    if (recorder.recording) drawBars(wave, live, { fromEnd: true, color: "#ff8b99" });
    else {
      live = [...live.slice(-120), Math.round(Math.sqrt(level) * 100)];
      drawBars(wave, live, { fromEnd: true, color: "#98a1b8" });
    }
    raf = requestAnimationFrame(draw);
  };

  function refresh() {
    const recording = recorder.recording;
    root.classList.toggle("is-recording", recording);
    root.classList.toggle("needs-tap", !recording && recorder.state === "open" && !recorder.running);
    button.setAttribute("aria-label", recording ? "Stop" : "Record");
    mark.hidden = !recording;
    dot.classList.toggle("on", recorder.state === "open" && recorder.running);
    micText.textContent = recording ? "Recording" : recorder.state === "open" && recorder.running ? "Mic is on" : recorder.state === "opening" ? "Opening the mic…" : "Mic off until you record";
    hint.classList.toggle("is-error", recorder.state === "denied" || recorder.state === "busy");
    if (recorder.state === "denied") hint.textContent = "MicFX can't use the microphone. Allow it in the browser's site settings, then tap Record again.";
    else if (recorder.state === "busy") hint.textContent = "The microphone is busy. Another app may be using it.";
    else if (!recording && !hint.textContent) hint.textContent = "Tap to record. Sing, hum or play.";
  }
  recorder.onState = refresh;

  async function start() {
    if (recorder.recording) return;
    navigator.vibrate?.(20);
    await recorder.open();
    if (recorder.state !== "open") return refresh();
    try {
      await recorder.start();
    } catch (error) {
      hint.textContent = `Couldn't start: ${error instanceof Error ? error.message : String(error)}`;
      return refresh();
    }
    live = [];
    hint.textContent = "";
    void lock();
    timer = window.setInterval(() => {
      time.textContent = formatTime(recorder.seconds);
      if (recorder.seconds > 25 * 60) hint.textContent = "Long take: it's saved as you go.";
    }, 100);
    refresh();
  }

  async function stop() {
    if (!recorder.recording) return;
    navigator.vibrate?.([20, 40, 20]);
    clearInterval(timer);
    unlock();
    const idea = await recorder.stop();
    time.textContent = "0:00.0";
    live = [];
    hint.textContent = "";
    refresh();
    if (idea) done(idea);
  }

  function done(idea: Idea) {
    hooks.saved(idea);
    void keepStorage();
    const name = el("input", { type: "text", class: "search", value: idea.name, "aria-label": "Name", maxLength: 80 });
    const note = el("input", { type: "text", class: "search", placeholder: "A note: words, a chord, where it goes…", "aria-label": "Note", maxLength: 300 });
    const chips = el("div", { class: "idea-meta" }, el("span", { class: "tag" }, formatTime(idea.length, false)), idea.interrupted ? el("span", { class: "tag warn" }, "Stopped early") : null);
    const audio = el("audio", { controls: true, preload: "auto", style: "width:100%" });
    void readAudio(idea).then((blob) => { audio.src = URL.createObjectURL(blob); });
    const save = async () => {
      const current = (await getIdea(idea.id)) ?? idea;
      await saveIdea({ ...current, name: name.value.trim() || current.name, note: note.value.trim() });
      hooks.saved(current);
    };
    name.addEventListener("change", save);
    note.addEventListener("change", save);
    last.replaceChildren(el("div", { class: "idea", style: "grid-template-columns:1fr;grid-template-areas:none" },
      el("div", { class: "idea-meta" }, el("b", {}, idea.interrupted ? "Saved: the recording stopped early" : "Saved"), chips), name, note, audio,
      el("div", { class: "rec-toggles", style: "justify-content:flex-start;margin-top:8px" }, el("button", { type: "button", class: "chip", onclick: () => hooks.openIdeas() }, "All ideas"))));
    // The key and tempo arrive a moment later.
    void readAudio(idea).then(analyse).then(async (result) => {
      const current = (await getIdea(idea.id)) ?? idea;
      const updated = { ...current, ...result };
      await saveIdea(updated);
      hooks.saved(updated);
      if (result.key) chips.append(el("span", { class: "tag" }, result.key));
      if (result.bpm) chips.append(el("span", { class: "tag" }, `${result.bpm} BPM`));
    }).catch(() => {});
  }

  recorder.onInterrupted = (idea) => {
    clearInterval(timer);
    unlock();
    time.textContent = "0:00.0";
    refresh();
    done(idea);
    toast("Recording stopped (a call or the screen locked). What you had is saved. Tap Record to carry on in a new take.");
  };

  button.addEventListener("click", () => void (recorder.recording ? stop() : start()));
  document.addEventListener("keydown", (event) => {
    if ((event.key === " " || event.key === "Enter") && document.activeElement === document.body) { event.preventDefault(); button.click(); }
  });
  raf = requestAnimationFrame(draw);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); if (recorder.recording) void lock(); }
  });
  refresh();
  return { root, refresh, start, stop };
}
