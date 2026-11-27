// Practice's web tools (plan section 9, points 16 and 17), in the Practice bar:
// - "Range": a short test for your lowest and highest comfortable notes; then each song
//   offers the key that fits your voice ("Fits you: +2").
// - "Warm-ups": scales, sirens and intervals made in any key, sung and scored like a song.
import { stemSplitEnabled } from "./stems-client";
import { PARTS, type Part } from "./harmony";
import { heldNote, readRange, spanText, suggestShift, writeRange, type VoiceRange } from "./range";
import { EXERCISES, TEMPOS, exerciseOf, makeWarmup, noteName, renderBacking, renderGuide, rootFor, type Tempo } from "./warmups";

export interface PracticeToolsHost {
  listenPitch(listener: (midi: number) => void): () => void;
  songRange(): { name: string; lowest: number; highest: number; semitones: number; speed: number } | undefined;
  setShift(semitones: number): Promise<unknown>;
  splitLeft(): { seconds: number; started: boolean } | undefined;
  currentPart(): Part;
  setPart(part: Part): Promise<void>;
  prepareMade(made: { name: string; key: string; seconds: number; guide: Float32Array; backing?: [Float32Array, Float32Array]; melody: string }): Promise<boolean>;
}

const RATE = 44100;
const LISTEN_SECONDS = 4;
const WARMUP_KEY = "micfx.warmup";

function html<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function button(className: string, text: string, title = "") {
  return Object.assign(html("button", className, text), { type: "button", title });
}

export function addPracticeTools(host: PracticeToolsHost, startAudio: () => Promise<unknown>) {
  const bar = document.querySelector(".practice-bar");
  if (!bar || bar.querySelector(".web-range-button")) return;
  const rangeButton = button("text-button practice-library-button web-range-button", "Range", "Find your lowest and highest comfortable notes; songs then offer the key that fits you");
  const warmupButton = button("text-button practice-library-button web-warmup-button", "Warm-ups", "Scales, sirens and intervals in any key, sung and scored like a song");
  const fit = button("tool web-fit-button", "", "");
  fit.hidden = true;
  // Beside Library and Lyrics; the key offer beside the Key menu's neighbours.
  const lyrics = [...bar.querySelectorAll(".practice-library-button")].at(-1);
  if (lyrics) lyrics.after(rangeButton, warmupButton);
  else bar.append(rangeButton, warmupButton);
  bar.insertBefore(fit, bar.querySelector(".practice-report-button"));

  // Duet mode: the part to sing (point 20).
  const part = html("label", "web-part");
  const partSelect = html("select", "dropdown web-part-select");
  partSelect.title = "The part you sing: the melody, or a harmony a third above or below it, each scored on its own. Two singers can take a part each.";
  for (const p of PARTS) partSelect.append(new Option(p.name, p.id));
  part.append(html("span", "web-part-label", "Part"), partSelect);
  bar.insertBefore(part, fit);
  partSelect.addEventListener("change", () => void host.setPart(partSelect.value as Part));

  const refreshFit = () => {
    const song = host.songRange();
    part.hidden = !song;
    partSelect.value = host.currentPart();
    const range = readRange();
    if (!song || !range) {
      fit.hidden = true;
      return;
    }
    const shift = suggestShift(song, range);
    const now = Math.round(song.semitones);
    fit.hidden = shift === now;
    fit.textContent = `Fits you: ${shift > 0 ? "+" : "−"}${Math.abs(shift)} st`;
    fit.title = `In your range (${noteName(range.low)} to ${noteName(range.high)}), this song sits best ${shift === 0 ? "in its own key" : `${Math.abs(shift)} semitone${Math.abs(shift) > 1 ? "s" : ""} ${shift > 0 ? "up" : "down"}`}. Click to sing it there.`;
    fit.dataset.shift = String(shift);
  };
  fit.addEventListener("click", () => {
    void host.setShift(Number(fit.dataset.shift ?? 0)).then(refreshFit);
  });
  // The song's line changes when a song opens or its key changes.
  const info = bar.querySelector(".practice-info");
  if (info) new MutationObserver(refreshFit).observe(info, { childList: true, characterData: true, subtree: true });
  refreshFit();

  addSplitTime(host);
  if (!stemSplitEnabled()) addSongWords();
  rangeButton.addEventListener("click", () => openRange(host, startAudio, refreshFit));
  warmupButton.addEventListener("click", () => openWarmups(host));
}

//==============================================================================
function dialogShell(label: string, title: string) {
  const dialog = html("dialog", "web-video web-practice-tool");
  dialog.setAttribute("aria-label", label);
  const head = html("div", "web-video-head");
  const close = button("mini", "×", "Close");
  close.setAttribute("aria-label", "Close");
  head.append(html("strong", "", title), close);
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  dialog.append(head);
  document.body.append(dialog);
  return dialog;
}

function openRange(host: PracticeToolsHost, startAudio: () => Promise<unknown>, done: () => void) {
  const dialog = dialogShell("Find your range", "Your range");
  const steps = [
    { label: "Lowest", prompt: "Sing your lowest comfortable note on “ah” and hold it." },
    { label: "Highest", prompt: "Now your highest comfortable note, not a strain: hold it." },
  ];
  const found: (number | undefined)[] = [undefined, undefined];
  const saved = readRange();
  const summary = html("p", "web-range-summary", saved ? rangeText(saved) : "A short test: hold two notes for a few seconds each.");
  const rows = steps.map((step, i) => {
    const row = html("div", "web-range-row");
    const note = html("strong", "web-range-note", saved ? noteName(i === 0 ? saved.low : saved.high) : "–");
    const status = html("span", "web-range-status", step.prompt);
    const go = button("tool web-range-go", `Sing ${step.label.toLowerCase()}`);
    const meter = html("span", "web-range-live", "");
    row.append(html("span", "web-range-label", step.label), note, status, meter, go);
    go.addEventListener("click", async () => {
      dialog.querySelectorAll<HTMLButtonElement>(".web-range-go").forEach((b) => (b.disabled = true));
      try {
        await startAudio();
        const readings: number[] = [];
        const stop = host.listenPitch((midi) => {
          readings.push(midi);
          meter.textContent = midi > 0 ? noteName(midi) : "…";
        });
        const started = performance.now();
        await new Promise<void>((resolve) => {
          const tick = () => {
            const left = LISTEN_SECONDS - (performance.now() - started) / 1000;
            status.textContent = left > 0 ? `Listening… ${Math.ceil(left)}` : "";
            if (left > 0) setTimeout(tick, 200);
            else resolve();
          };
          tick();
        });
        stop();
        meter.textContent = "";
        const held = heldNote(readings);
        if (held === undefined) {
          status.textContent = "No steady note heard. Hold one note on “ah”, a little louder, and try again.";
        } else {
          found[i] = held;
          note.textContent = noteName(held);
          status.textContent = "Got it.";
        }
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        dialog.querySelectorAll<HTMLButtonElement>(".web-range-go").forEach((b) => (b.disabled = false));
        finish();
      }
    });
    return row;
  });

  const save = button("tool is-accent web-range-save", "Keep this range");
  save.disabled = true;
  const forget = button("tool web-range-forget", "Forget my range");
  forget.hidden = !saved;
  const finish = () => {
    const [low, high] = found;
    const ready = low !== undefined && high !== undefined;
    if (ready && high! - low! < 3) {
      summary.textContent = "Those are very close together: sing the lowest as low as is comfortable, and the highest as high.";
      save.disabled = true;
      return;
    }
    save.disabled = !ready;
    if (ready) summary.textContent = rangeText({ low: Math.min(low!, high!), high: Math.max(low!, high!), at: Date.now() });
  };
  save.addEventListener("click", () => {
    const [a, b] = found as [number, number];
    writeRange({ low: Math.round(Math.min(a, b)), high: Math.round(Math.max(a, b)), at: Date.now() });
    done();
    dialog.close();
  });
  forget.addEventListener("click", () => {
    writeRange(undefined);
    done();
    dialog.close();
  });
  const note = html("p", "web-video-note", "Headphones help: the song stays out of the mic. Your range is kept in this browser; each song then offers the key that fits it.");
  const actions = html("div", "web-video-actions");
  actions.append(forget, save);
  dialog.append(summary, ...rows, note, actions);
  dialog.showModal();
}

function rangeText(range: VoiceRange) {
  return `Your range: ${noteName(range.low)} to ${noteName(range.high)} (${spanText(range.high - range.low)}).`;
}

//==============================================================================
function openWarmups(host: PracticeToolsHost) {
  const dialog = dialogShell("Warm-ups", "Warm-ups");
  let saved: { exercise?: string; rounds?: number; tempo?: Tempo; root?: number } = {};
  try {
    saved = JSON.parse(localStorage.getItem(WARMUP_KEY) ?? "{}") ?? {};
  } catch {
    // the defaults
  }
  const range = readRange();
  const exercise = html("select", "dropdown web-warmup-exercise");
  for (const e of EXERCISES) exercise.append(new Option(e.name, e.id));
  exercise.value = exerciseOf(saved.exercise ?? "five").id;
  const rounds = html("select", "dropdown web-warmup-rounds");
  for (let n = 1; n <= 8; ++n) rounds.append(new Option(n === 1 ? "Once" : `${n} times, a semitone up each`, String(n)));
  rounds.value = String(saved.rounds ?? 4);
  const tempo = html("select", "dropdown web-warmup-tempo");
  for (const [value, label] of [["slow", "Slow"], ["medium", "Medium"], ["fast", "Fast"]] as const) tempo.append(new Option(`${label} (${TEMPOS[value]} BPM)`, value));
  tempo.value = saved.tempo && saved.tempo in TEMPOS ? saved.tempo : "medium";
  const root = html("select", "dropdown web-warmup-root");
  for (let midi = 36; midi <= 72; ++midi) root.append(new Option(noteName(midi), String(midi)));
  const suggested = () => rootFor(exerciseOf(exercise.value), Number(rounds.value), range);
  root.value = String(saved.root ?? suggested());
  const fitsNote = html("p", "web-video-note", "");
  const updateNote = () => {
    const e = exerciseOf(exercise.value);
    const top = Number(root.value) + Math.max(...e.steps) + Number(rounds.value) - 1;
    fitsNote.textContent = range
      ? top > range.high || Number(root.value) < range.low
        ? `This goes ${noteName(Number(root.value))} to ${noteName(top)}, outside your range (${noteName(range.low)} to ${noteName(range.high)}). ${noteName(suggested())} fits.`
        : `${noteName(Number(root.value))} to ${noteName(top)}: inside your range.`
      : `${noteName(Number(root.value))} to ${noteName(top)}. Find your range and warm-ups start where it suits you.`;
  };
  exercise.addEventListener("change", () => {
    root.value = String(suggested());
    updateNote();
  });
  rounds.addEventListener("change", updateNote);
  root.addEventListener("change", updateNote);
  updateNote();

  const form = html("div", "web-warmup-form");
  const field = (label: string, control: HTMLElement) => {
    const wrap = html("label", "web-warmup-field");
    wrap.append(html("span", "", label), control);
    return wrap;
  };
  form.append(field("Exercise", exercise), field("Start on", root), field("Times round", rounds), field("Tempo", tempo));
  const status = html("span", "web-video-status", "");
  const sing = button("tool is-accent web-warmup-sing", "Sing it");
  const actions = html("div", "web-video-actions");
  actions.append(status, sing);
  sing.addEventListener("click", async () => {
    const settings = { exercise: exercise.value, root: Number(root.value), rounds: Number(rounds.value), tempo: tempo.value as Tempo };
    try {
      localStorage.setItem(WARMUP_KEY, JSON.stringify(settings));
    } catch {
      // not kept
    }
    sing.disabled = true;
    status.textContent = "Making it…";
    await new Promise((resolve) => setTimeout(resolve, 20)); // (the words show first)
    const warmup = makeWarmup(settings);
    const ok = await host.prepareMade({
      name: `Warm-up: ${warmup.name}`,
      key: warmup.key,
      seconds: warmup.seconds,
      guide: renderGuide(warmup, RATE, Boolean(exerciseOf(settings.exercise).glide)),
      backing: renderBacking(warmup, RATE),
      melody: warmup.melody,
    });
    sing.disabled = false;
    if (ok) dialog.close();
    else status.textContent = "Couldn't make it.";
  });
  dialog.append(form, fitsNote, actions);
  dialog.showModal();
}

//==============================================================================
/** "About 3 min" (point 18): how long splitting a song takes, then how long it has left. */
export function durationText(seconds: number): string {
  if (seconds < 50) return "under a minute";
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "about a minute" : `about ${minutes} min`;
}

function addSplitTime(host: PracticeToolsHost) {
  const text = document.querySelector(".practice-overlay-info");
  if (!text || document.querySelector(".web-split-time")) return;
  const time = html("span", "web-split-time", "");
  text.after(time);
  setInterval(() => {
    const left = host.splitLeft();
    const value = left ? (left.started ? `${durationText(left.seconds)} left` : `Splitting takes ${durationText(left.seconds)} here`) : "";
    if (time.textContent !== value) time.textContent = value;
  }, 500);
}

/** Without the stem split (too slow in a browser) a song plays as it is, with its voice taken down: say so. */
function addSongWords() {
  const open = document.querySelector<HTMLElement>(".practice-open");
  if (open) open.title = "Choose a song: it plays as the backing with its voice taken down; its melody is shown to sing";
  const text = document.querySelector<HTMLElement>(".practice-empty p:not(.big)");
  if (text) text.textContent = "Open a song: it plays as the backing with its centred voice taken down (the original sits under it as a quiet guide you can turn up or off), and its melody is turned into notes to sing. Sing in any octave; each note turns green when you're within a quarter of a semitone.";
}
