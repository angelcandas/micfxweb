// The "native" side of JUCE's WebView bridge, in the browser.
//
// The desktop UI (extern/local-mic-effects/ui) talks to C++ through JUCE's frontend library
// (ui/juce/index.js): getNativeFunction(), getSliderState()/getToggleState()/getComboBoxState()
// and backend events. That library speaks a small message protocol over window.__JUCE__:
//
//   page -> native: window.__JUCE__.postMessage(JSON { eventId, payload })
//     "__juce__invoke"            { name, params, resultId }       call a native function
//     "__juce__slider<id>" etc.   { eventType, value? }             a control's relay
//   native -> page: window.__JUCE__.backend.emitByBackend(eventId, JSON payload)
//     "__juce__complete"          { promiseId, result }
//     "__juce__slider<id>" etc.   { eventType: "valueChanged" | "propertiesChanged", ... }
//
// JuceBackend plays the C++ side of that protocol, so the desktop UI runs unchanged with
// TypeScript functions in place of the C++ ones. install() must run before the desktop's
// juce/index.js is imported.

/** A parameter as the engine describes it (the desktop's getParameterInfo shape). */
export interface ParameterInfo {
  name: string;
  min: number;
  max: number;
  skew: number;
  step: number;
  label: string;
  default: number;
  choices?: string[];
  bool?: true;
}

export type NativeFunction = (...args: any[]) => unknown;

export interface BackendOptions {
  /** The parameters, by ID, in the desktop's order (each gets a relay named after its ID). */
  parameters: Record<string, ParameterInfo>;
  /** Native functions by name. */
  functions: Record<string, NativeFunction>;
  /** Called when the page changes a parameter (real units). */
  onParameterChanged?: (id: string, value: number) => void;
  /** Called for a function the page calls that isn't implemented. */
  onMissingFunction?: (name: string) => void;
}

interface JuceWindow {
  __JUCE__?: {
    initialisationData: Record<string, unknown[]>;
    postMessage: (message: string) => void;
    backend?: { emitByBackend: (eventId: string, payload: string) => void };
  };
}

type Kind = "slider" | "toggle" | "comboBox";

export class JuceBackend {
  private readonly values = new Map<string, number>();
  private readonly kinds = new Map<string, Kind>();
  private readonly parameterIndex = new Map<string, number>();

  constructor(private readonly options: BackendOptions) {
    Object.entries(options.parameters).forEach(([id, info], index) => {
      this.values.set(id, info.default);
      this.kinds.set(id, info.bool ? "toggle" : info.choices ? "comboBox" : "slider");
      this.parameterIndex.set(id, index);
    });
  }

  /** Defines window.__JUCE__ for the desktop's juce/index.js. Call once, before importing it. */
  install(target: Window = window): void {
    const ids = (kind: Kind) => [...this.kinds].filter(([, k]) => k === kind).map(([id]) => id);
    (target as unknown as JuceWindow).__JUCE__ = {
      initialisationData: {
        __juce__platform: ["web"],
        __juce__functions: Object.keys(this.options.functions),
        __juce__registeredGlobalEventIds: [],
        __juce__sliders: ids("slider"),
        __juce__toggles: ids("toggle"),
        __juce__comboBoxes: ids("comboBox"),
      },
      // The page's messages arrive asynchronously, as they do from a real WebView.
      postMessage: (message: string) => queueMicrotask(() => this.receive(message)),
    };
  }

  /** Sends an event to the page (the C++ side's emitEventIfBrowserIsVisible). */
  emit(eventId: string, payload: unknown = null): void {
    const backend = (window as unknown as JuceWindow).__JUCE__?.backend;
    backend?.emitByBackend(eventId, JSON.stringify(payload ?? null));
  }

  /** A parameter's value in real units. */
  getParameter(id: string): number | undefined {
    return this.values.get(id);
  }

  /** Every parameter's value. */
  getParameters(): Record<string, number> {
    return Object.fromEntries(this.values);
  }

  /** Changes a parameter from the "native" side (a preset, MIDI...); the page's control follows. */
  setParameter(id: string, value: number): void {
    const kind = this.kinds.get(id);
    if (!kind) return;
    const clamped = this.constrain(id, value);
    if (this.values.get(id) === clamped) return;
    this.values.set(id, clamped);
    this.emit(this.relayId(kind, id), { eventType: "valueChanged", value: this.toRelayValue(id, clamped) });
  }

  private receive(message: string) {
    let parsed: { eventId: string; payload: any };
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    const { eventId, payload } = parsed;
    if (eventId === "__juce__invoke") return void this.invoke(payload);
    const relay = /^__juce__(slider|toggle|comboBox)(.+)$/.exec(eventId);
    if (relay) this.relayEvent(relay[1] as Kind, relay[2]!, payload);
  }

  private async invoke({ name, params, resultId }: { name: string; params: unknown[]; resultId: number }) {
    const fn = this.options.functions[name];
    let result: unknown = null;
    if (fn) {
      try {
        result = await fn(...(params ?? []));
      } catch (error) {
        console.error(`Native function ${name} failed`, error);
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    } else {
      this.options.onMissingFunction?.(name);
    }
    this.emit("__juce__complete", { promiseId: resultId, result: result ?? null });
  }

  private relayEvent(kind: Kind, id: string, event: { eventType: string; value?: unknown }) {
    if (this.kinds.get(id) !== kind) return;
    const relayId = this.relayId(kind, id);
    if (event.eventType === "requestInitialUpdate") {
      this.emit(relayId, { eventType: "propertiesChanged", ...this.properties(id) });
      this.emit(relayId, { eventType: "valueChanged", value: this.toRelayValue(id, this.values.get(id)!) });
    } else if (event.eventType === "valueChanged") {
      const value = this.constrain(id, this.fromRelayValue(id, event.value));
      if (this.values.get(id) === value) return;
      this.values.set(id, value);
      this.options.onParameterChanged?.(id, value);
    }
    // sliderDragStarted / sliderDragEnded: gestures (undo grouping on the desktop); nothing here.
  }

  private relayId(kind: Kind, id: string) {
    return `__juce__${kind}${id}`;
  }

  private properties(id: string) {
    const info = this.options.parameters[id]!;
    const base = { name: info.name, parameterIndex: this.parameterIndex.get(id) ?? -1 };
    if (info.bool) return base;
    if (info.choices) return { ...base, choices: info.choices };
    return {
      ...base,
      start: info.min,
      end: info.max,
      skew: info.skew,
      label: info.label,
      interval: info.step,
      numSteps: info.step > 0 ? Math.round((info.max - info.min) / info.step) + 1 : 1000,
    };
  }

  // Toggles carry a boolean, combo boxes their index as 0..1, sliders the real value.
  private toRelayValue(id: string, value: number): unknown {
    const info = this.options.parameters[id]!;
    if (info.bool) return value >= 0.5;
    if (info.choices) return info.choices.length > 1 ? value / (info.choices.length - 1) : 0;
    return value;
  }

  private fromRelayValue(id: string, value: unknown): number {
    const info = this.options.parameters[id]!;
    if (info.bool) return value ? 1 : 0;
    if (info.choices) return Math.round(Number(value) * Math.max(0, info.choices.length - 1));
    return Number(value);
  }

  private constrain(id: string, value: number): number {
    const info = this.options.parameters[id]!;
    if (!Number.isFinite(value)) return this.values.get(id) ?? info.default;
    if (info.bool) return value >= 0.5 ? 1 : 0;
    const clamped = Math.min(info.max, Math.max(info.min, value));
    if (info.choices) return Math.round(clamped);
    if (!(info.step > 0)) return clamped;
    const snapped = info.min + Math.round((clamped - info.min) / info.step) * info.step;
    return Math.min(info.max, Number(snapped.toFixed(6))); // no 0.30000000000000004
  }
}
