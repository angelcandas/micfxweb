// MicFX Voice: a first page around the engine. The desktop app's own Live UI replaces it
// in a later PR (docs/plan.md, section 4).
import { LiveAudio } from "./audio";

// A few of the desktop effects, by their switch IDs, to try the engine with.
const EFFECTS: { id: string; name: string; note: string }[] = [
  { id: "tuneOn", name: "Autotune", note: "Chromatic" },
  { id: "harmonyOn", name: "Harmonizer", note: "Two voices" },
  { id: "doublerOn", name: "Doubler", note: "Wider vocal" },
  { id: "robotOn", name: "Robot", note: "Character" },
  { id: "radioOn", name: "Radio", note: "Lo-fi" },
  { id: "delayOn", name: "Echo", note: "Ping-pong" },
  { id: "reverbOn", name: "Reverb", note: "Room" },
  { id: "denoiseOn", name: "Denoise", note: "Clean-up" },
];

const audio = new LiveAudio();
const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;

const startButton = $<HTMLButtonElement>(".start");
const errorText = $<HTMLParagraphElement>(".error");
const latency = $<HTMLSpanElement>(".latency");
const effects = $<HTMLDivElement>(".effects");
const dryButton = $<HTMLButtonElement>(".dry");
const meterFills = {
  input: $<HTMLDivElement>('[data-meter="input"]'),
  output: $<HTMLDivElement>('[data-meter="output"]'),
};

const state: Record<string, number> = {};

for (const effect of EFFECTS) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "effect";
  button.dataset.id = effect.id;
  button.setAttribute("aria-pressed", "false");
  button.innerHTML = `${effect.name}<small>${effect.note}</small>`;
  button.addEventListener("click", () => {
    const on = button.getAttribute("aria-pressed") !== "true";
    button.setAttribute("aria-pressed", String(on));
    state[effect.id] = on ? 1 : 0;
    audio.set({ [effect.id]: state[effect.id]! });
  });
  effects.append(button);
}

for (const input of document.querySelectorAll<HTMLInputElement>("input[data-value]")) {
  const show = () => (input.nextElementSibling!.textContent = `${Number(input.value) > 0 ? "+" : ""}${input.value} dB`);
  input.addEventListener("input", () => {
    state[input.dataset.value!] = Number(input.value);
    audio.set({ [input.dataset.value!]: Number(input.value) });
    show();
  });
}

const setDry = (held: boolean) => {
  dryButton.classList.toggle("is-held", held);
  audio.set({ dryCompare: held ? 1 : 0 });
};
dryButton.addEventListener("pointerdown", () => setDry(true));
for (const type of ["pointerup", "pointerleave", "pointercancel"]) dryButton.addEventListener(type, () => setDry(false));
document.addEventListener("keydown", (event) => event.key.toLowerCase() === "d" && !event.repeat && setDry(true));
document.addEventListener("keyup", (event) => event.key.toLowerCase() === "d" && setDry(false));

const toPercent = (peak: number) => {
  const db = 20 * Math.log10(Math.max(peak, 1e-6));
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
};

audio.onMeters = (meters) => {
  for (const key of ["input", "output"] as const) {
    meterFills[key].style.width = `${toPercent(meters[key])}%`;
    meterFills[key].classList.toggle("is-hot", meters[key] > 0.89);
  }
  const ms = audio.latencyMs();
  if (ms !== undefined) {
    latency.textContent = `≈ ${Math.round(ms)} ms latency`;
    latency.classList.toggle("is-high", ms > 30);
  }
};

startButton.addEventListener("click", async () => {
  errorText.hidden = true;
  if (audio.running) {
    await audio.stop();
    startButton.textContent = "Start mic";
    startButton.classList.remove("is-on");
    latency.textContent = "—";
    document.body.dataset.audio = "off";
    return;
  }
  startButton.disabled = true;
  startButton.textContent = "Starting…";
  try {
    // Start from the desktop's defaults with every effect off, then what's switched on here.
    const info = await audio.start();
    const off: Record<string, number> = {};
    for (const value of info.values) if (value.isSwitch) off[value.id] = 0;
    audio.preset({ ...off, ...state });
    startButton.textContent = "Stop";
    startButton.classList.add("is-on");
    document.body.dataset.audio = "on";
  } catch (error) {
    await audio.stop();
    startButton.textContent = "Start mic";
    errorText.textContent =
      error instanceof DOMException && error.name === "NotAllowedError"
        ? "MicFX needs your microphone. Allow it in the browser's address bar, then try again."
        : `Couldn't start: ${error instanceof Error ? error.message : String(error)}`;
    errorText.hidden = false;
  } finally {
    startButton.disabled = false;
  }
});
