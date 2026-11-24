// MicFX Voice: a first page around the engine. The desktop app's own Live UI replaces it
// in a later PR (docs/plan.md, section 4).
import type { FactoryPreset } from "@micfx/engine";
import { LiveAudio, loadCatalog } from "./audio";

// A few of the desktop effects, by their switch IDs, to try the engine with.
const EFFECTS: { id: string; name: string; note: string }[] = [
  { id: "tuneOn", name: "Autotune", note: "Pitch" },
  { id: "harmonyOn", name: "Harmonizer", note: "Pitch" },
  { id: "doublerOn", name: "Doubler", note: "Space" },
  { id: "robotOn", name: "Robot", note: "Character" },
  { id: "radioOn", name: "Radio", note: "Character" },
  { id: "delayOn", name: "Echo", note: "Space" },
  { id: "reverbOn", name: "Reverb", note: "Space" },
  { id: "denoiseOn", name: "Denoise", note: "Clean-up" },
  { id: "compOn", name: "Compressor", note: "Clean-up" },
  { id: "satOn", name: "Saturation", note: "Character" },
  { id: "eqOn", name: "EQ", note: "Clean-up" },
  { id: "chorusOn", name: "Chorus", note: "Modulation" },
];

const audio = new LiveAudio();
const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;

const startButton = $<HTMLButtonElement>(".start");
const errorText = $<HTMLParagraphElement>(".error");
const latency = $<HTMLSpanElement>(".latency");
const effects = $<HTMLDivElement>(".effects");
const dryButton = $<HTMLButtonElement>(".dry");
const presetSelect = $<HTMLSelectElement>(".preset-select");
const meterFills = {
  input: $<HTMLDivElement>('[data-meter="input"]'),
  output: $<HTMLDivElement>('[data-meter="output"]'),
};

// The values the page has set since the last preset (sent again when the audio restarts).
let changes: Record<string, number> = {};
let presets: FactoryPreset[] = [];
let presetIndex = 0;
let defaults: Record<string, number> = {};

const effectButtons = new Map<string, HTMLButtonElement>();
for (const effect of EFFECTS) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "effect";
  button.setAttribute("aria-pressed", "false");
  button.innerHTML = `${effect.name}<small>${effect.note}</small>`;
  button.addEventListener("click", () => {
    const on = button.getAttribute("aria-pressed") !== "true";
    button.setAttribute("aria-pressed", String(on));
    changes[effect.id] = on ? 1 : 0;
    audio.set({ [effect.id]: on ? 1 : 0 });
  });
  effectButtons.set(effect.id, button);
  effects.append(button);
}

const gainInputs = [...document.querySelectorAll<HTMLInputElement>("input[data-value]")];
const showGain = (input: HTMLInputElement) =>
  (input.nextElementSibling!.textContent = `${Number(input.value) > 0 ? "+" : ""}${Number(input.value)} dB`);
for (const input of gainInputs) {
  input.addEventListener("input", () => {
    changes[input.dataset.value!] = Number(input.value);
    audio.set({ [input.dataset.value!]: Number(input.value) });
    showGain(input);
  });
}

/** Shows values (a preset's, or the defaults) on the controls. */
function showValues(values: Record<string, number>) {
  for (const [id, button] of effectButtons) button.setAttribute("aria-pressed", String((values[id] ?? 0) >= 0.5));
  for (const input of gainInputs) {
    const value = values[input.dataset.value!];
    if (value !== undefined) {
      input.value = String(value);
      showGain(input);
    }
  }
}

/** A preset's values on top of the defaults, the input gain kept (the desktop's applyPreset). */
function presetValues(index: number): Record<string, number> {
  const { inputGain: _, ...rest } = defaults;
  return { ...rest, ...presets[index]?.values };
}

function selectPreset(index: number) {
  presetIndex = (index + presets.length) % presets.length;
  presetSelect.value = String(presetIndex);
  changes = {};
  showValues(presetValues(presetIndex));
  audio.loadPreset(presetIndex);
}

presetSelect.addEventListener("change", () => selectPreset(Number(presetSelect.value)));
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-preset-step]"))
  button.addEventListener("click", () => selectPreset(presetIndex + Number(button.dataset.presetStep)));
audio.onValues = (values) => showValues(values);

const setDry = (held: boolean) => {
  dryButton.classList.toggle("is-held", held);
  audio.set({ dryCompare: held ? 1 : 0 });
};
dryButton.addEventListener("pointerdown", () => setDry(true));
for (const type of ["pointerup", "pointerleave", "pointercancel"]) dryButton.addEventListener(type, () => setDry(false));
document.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement) return;
  if (event.key.toLowerCase() === "d" && !event.repeat) setDry(true);
});
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
    await audio.start();
    audio.loadPreset(presetIndex);
    audio.set(changes); // what was changed on top of the preset
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

// The desktop's presets and defaults, before any audio starts.
loadCatalog()
  .then((catalog) => {
    presets = catalog.presets;
    defaults = Object.fromEntries(Object.entries(catalog.parameters).map(([id, info]) => [id, info.default]));
    const groups = new Map<string, HTMLOptGroupElement>();
    presets.forEach((preset, index) => {
      let group = groups.get(preset.category);
      if (!group) {
        group = document.createElement("optgroup");
        group.label = preset.category;
        groups.set(preset.category, group);
        presetSelect.append(group);
      }
      group.append(new Option(preset.name, String(index)));
    });
    presetSelect.value = "0";
    showValues(presetValues(0));
    document.body.dataset.catalog = "ready";
  })
  .catch((error) => {
    errorText.textContent = `Couldn't load the audio engine: ${error instanceof Error ? error.message : String(error)}`;
    errorText.hidden = false;
  });
