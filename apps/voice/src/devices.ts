// The web's "Audio settings…": the browser has no device dialog of its own, so this is a
// small one in the desktop's settings style (its modal() and setup-* classes): which mic,
// which output (where the browser can choose), start or stop the sound, and the latency.
import { RATES, readAudioPrefs, writeAudioPrefs, type RatePref } from "@micfx/engine/audio-prefs";
import type { LiveAudio } from "./audio";

const DESKTOP = new URL("desktop/", document.baseURI).href;
const INPUT_KEY = "micfx.audio.input";
const OUTPUT_KEY = "micfx.audio.output";

type Modal = (className: string, title: string, onClose: () => void) => { backdrop: HTMLElement; body: HTMLElement };

function pref(key: string, value?: string): string {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export const savedInput = () => pref(INPUT_KEY);
export const savedOutput = () => pref(OUTPUT_KEY);

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
};

export function createAudioSettings(audio: LiveAudio, start: () => Promise<unknown>, changed: () => void) {
  let dialog: { backdrop: HTMLElement; body: HTMLElement } | undefined;
  const canPickOutput = typeof (AudioContext.prototype as unknown as { setSinkId?: unknown }).setSinkId === "function";

  const input = el("select", "dropdown");
  input.setAttribute("aria-label", "Microphone");
  const output = el("select", "dropdown");
  output.setAttribute("aria-label", "Output");
  const power = el("button", "tool is-accent");
  power.type = "button";
  const latency = el("span", "setup-value");
  const parts = el("span", "setup-value web-latency-parts");
  const note = el("p", "setup-lead");

  // The sample rate and the low latency switch (shared with MicFX DAW): the sound restarts.
  const rate = el("select", "dropdown web-sample-rate");
  rate.setAttribute("aria-label", "Sample rate");
  for (const { value, label } of RATES) rate.append(new Option(label, String(value)));
  const lowLatency = el("input", "web-low-latency");
  lowLatency.type = "checkbox";
  lowLatency.setAttribute("aria-label", "Low latency");
  const lowLatencyLabel = el("label", "web-switch");
  lowLatencyLabel.append(lowLatency, el("span", "", "Smallest buffers"));
  const restart = async () => {
    if (!audio.running) return;
    await audio.stop();
    await start();
    changed();
  };
  rate.addEventListener("change", async () => {
    writeAudioPrefs({ ...readAudioPrefs(), rate: Number(rate.value) as RatePref });
    await restart();
    await render();
  });
  lowLatency.addEventListener("change", async () => {
    writeAudioPrefs({ ...readAudioPrefs(), lowLatency: lowLatency.checked });
    await restart();
    await render();
  });

  input.addEventListener("change", async () => {
    pref(INPUT_KEY, input.value);
    if (audio.running) {
      await audio.stop();
      await start();
    }
    changed();
    render();
  });
  output.addEventListener("change", async () => {
    pref(OUTPUT_KEY, output.value);
    await audio.setOutput(output.value).catch(() => {});
    render();
  });
  power.addEventListener("click", async () => {
    if (audio.running) await audio.stop();
    else await start();
    changed();
    render();
  });

  const fill = (select: HTMLSelectElement, devices: MediaDeviceInfo[], chosen: string, fallback: string) => {
    select.replaceChildren(new Option(fallback, ""), ...devices.map((d, i) => new Option(d.label || `${fallback} ${i + 1}`, d.deviceId)));
    select.value = devices.some((d) => d.deviceId === chosen) ? chosen : "";
  };

  async function render() {
    const devices = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []) ?? [];
    fill(input, devices.filter((d) => d.kind === "audioinput" && d.deviceId !== "default"), savedInput(), "Default microphone");
    fill(output, devices.filter((d) => d.kind === "audiooutput" && d.deviceId !== "default"), savedOutput(), "Default output");
    power.textContent = audio.running ? "Stop sound" : "Start sound";
    const prefs = readAudioPrefs();
    rate.value = String(prefs.rate);
    lowLatency.checked = prefs.lowLatency;
    const ms = audio.latencyMs();
    latency.textContent = ms === undefined ? "Start the sound to measure it" : `About ${Math.round(ms)} ms from your voice to your ears`;
    const p = audio.latencyParts();
    parts.hidden = !p;
    if (p) {
      const fmt = (v: number) => (v < 10 ? v.toFixed(1) : String(Math.round(v)));
      const bits = [
        p.input !== undefined ? `mic ${fmt(p.input)} ms` : undefined,
        `buffer ${fmt(p.base)} ms`,
        p.output ? `output ${fmt(p.output)} ms` : undefined,
        p.effects ? `effects ${fmt(p.effects)} ms` : undefined,
      ].filter(Boolean);
      parts.textContent = `${bits.join(" + ")} at ${p.rate / 1000} kHz`;
      parts.title = p.effects >= 5 ? "Denoise and Smooth add the most delay: turn them off (or Smooth to Fast) to sing with less." : "";
    }
    note.textContent = devices.every((d) => !d.label)
      ? "Start the sound once to see your devices' names (the browser shows them after you allow the mic)."
      : "Wired headphones keep the delay low. Bluetooth adds 100 ms or more, too much to sing with.";
  }

  return {
    async open() {
      if (!dialog) {
        const { modal } = (await import(/* @vite-ignore */ `${DESKTOP}setup.js`)) as { modal: Modal };
        dialog = modal("web-audio-settings", "Audio settings", () => (dialog!.backdrop.hidden = true));
        const section = el("section", "setup-section");
        const row = (label: string, ...controls: HTMLElement[]) => {
          const r = el("div", "setup-row");
          r.append(el("span", "setup-row-label", label), ...controls);
          section.append(r);
          return r;
        };
        row("Microphone", input);
        row("Output", output).hidden = !canPickOutput;
        row("Sound", power);
        row("Latency", latency);
        row("", parts);
        row("Sample rate", rate).title = "Match your interface's rate to avoid resampling. 96 kHz halves the browser's buffer time but doubles the work.";
        row("Low latency", lowLatencyLabel).title = "Asks the browser for its smallest buffers. Turn it off if the sound crackles.";
        dialog.body.append(section, note);
      }
      await render();
      dialog.backdrop.hidden = false;
      input.focus();
    },
  };
}
