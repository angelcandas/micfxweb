// Live undo/redo and scenes: the desktop's LiveHistory and Scenes (src/LiveHistory.cpp,
// src/Scenes.cpp) on the page's thread, over the same parameters. Both work on the
// desktop's normalised values (0..1, with each parameter's skew), as the C++ does.
import type { ParameterInfo } from "@micfx/bridge";

/** The parameters, as the page keeps them (the shadow engine). */
export interface ParameterAccess {
  readonly ids: string[];
  readonly info: Record<string, ParameterInfo>;
  get(id: string): number;
  /** Sets a real value everywhere: engine, audio and the page's controls. */
  set(id: string, value: number): void;
}

//==============================================================================
// JUCE's NormalisableRange (without the symmetric skew, which MicFX doesn't use).

export function toNormalised(info: ParameterInfo, value: number): number {
  if (info.choices) return info.choices.length > 1 ? clamp01(value / (info.choices.length - 1)) : 0;
  if (info.bool) return value >= 0.5 ? 1 : 0;
  const proportion = clamp01((value - info.min) / (info.max - info.min || 1));
  return info.skew === 1 || proportion === 0 ? proportion : Math.pow(proportion, info.skew);
}

export function fromNormalised(info: ParameterInfo, normalised: number): number {
  const n = clamp01(normalised);
  if (info.choices) return Math.round(n * Math.max(0, info.choices.length - 1));
  if (info.bool) return n >= 0.5 ? 1 : 0;
  const proportion = info.skew === 1 || n === 0 ? n : Math.exp(Math.log(n) / info.skew);
  let value = info.min + (info.max - info.min) * proportion;
  if (info.step > 0) value = Number((info.min + Math.round((value - info.min) / info.step) * info.step).toFixed(6));
  return Math.min(info.max, Math.max(info.min, value));
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

//==============================================================================
/**
 * Undo for Live mode: every change to the sound is one named step. It watches the values
 * rather than being told of each edit; a change is committed once they rest for 350 ms,
 * which joins a knob drag or a scene glide into one step.
 */
export class LiveHistory {
  static readonly maxSteps = 100;
  static readonly restMs = 350;

  onChange: () => void = () => {};
  getPreset: () => number = () => -1;
  setPreset: (index: number) => void = () => {};

  private committed: number[];
  private last: number[];
  private committedPreset: number;
  private lastChangeMs = 0;
  private pendingLabel = "";
  private labelMs = 0;
  private held = false;
  private undoSteps: { before: number[]; after: number[]; name: string; presetBefore: number; presetAfter: number }[] = [];
  private redoSteps: typeof this.undoSteps = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly params: ParameterAccess,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.committed = this.last = this.take();
    this.committedPreset = -1;
  }

  /** Watches the values every 50 ms (tests call tick() themselves). */
  start(): void {
    this.committed = this.last = this.take(); // the restored sound is where undo starts
    this.committedPreset = this.getPreset();
    this.timer ??= setInterval(() => this.tick(), 50);
  }

  /** Names the next step (until it's committed or a second passes with no change). */
  label(name: string): void {
    this.flush();
    this.pendingLabel = name;
    this.labelMs = this.now();
  }

  hold(name: string): void {
    if (this.held) return;
    this.label(name);
    this.held = true;
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    const name = this.pendingLabel;
    this.flush();
    if (this.pendingLabel === name) this.pendingLabel = "";
  }

  undo(): boolean {
    this.release();
    this.flush();
    const step = this.undoSteps.pop();
    if (!step) return false;
    this.apply(step.before);
    this.setPreset((this.committedPreset = step.presetBefore));
    this.committed = this.last = this.take();
    this.redoSteps.push(step);
    this.onChange();
    return true;
  }

  redo(): boolean {
    this.release();
    this.flush();
    const step = this.redoSteps.pop();
    if (!step) return false;
    this.apply(step.after);
    this.setPreset((this.committedPreset = step.presetAfter));
    this.committed = this.last = this.take();
    this.undoSteps.push(step);
    this.onChange();
    return true;
  }

  get undoName(): string {
    return this.undoSteps.at(-1)?.name ?? "";
  }

  get redoName(): string {
    return this.redoSteps.at(-1)?.name ?? "";
  }

  /** Commits a pending change at once. */
  flush(): void {
    if (this.held) return;
    const now = this.take();
    this.last = now;
    this.commit(now);
  }

  /** Forgets every step: the current sound is where undo starts. */
  clear(): void {
    this.held = false;
    this.undoSteps = [];
    this.redoSteps = [];
    this.committed = this.last = this.take();
    this.committedPreset = this.getPreset();
    this.pendingLabel = "";
    this.onChange();
  }

  tick(): void {
    if (this.held) return;
    const nowMs = this.now();
    const now = this.take();
    if (!same(now, this.last)) {
      this.last = now;
      this.lastChangeMs = nowMs;
      return;
    }
    if (!same(now, this.committed) && nowMs - this.lastChangeMs >= LiveHistory.restMs) this.commit(now);
    else if (this.pendingLabel && same(now, this.committed) && nowMs - this.labelMs > 1000) this.pendingLabel = "";
  }

  private take(): number[] {
    return this.params.ids.map((id) => this.params.get(id));
  }

  private apply(values: number[]) {
    this.params.ids.forEach((id, i) => {
      const value = values[i];
      if (value !== undefined && this.params.get(id) !== value) this.params.set(id, value);
    });
  }

  private commit(now: number[]) {
    if (same(now, this.committed)) return;
    const preset = this.getPreset();
    this.undoSteps.push({
      before: this.committed,
      after: now,
      name: this.pendingLabel || this.describe(this.committed, now),
      presetBefore: this.committedPreset,
      presetAfter: preset,
    });
    if (this.undoSteps.length > LiveHistory.maxSteps) this.undoSteps.shift();
    this.redoSteps = [];
    this.committedPreset = preset;
    this.committed = now;
    this.pendingLabel = "";
    this.onChange();
  }

  private describe(before: number[], after: number[]): string {
    const changed = this.params.ids.filter((_, i) => before[i] !== after[i]);
    if (changed.length === 1) return this.params.info[changed[0]!]?.name ?? changed[0]!;
    return `Change ${changed.length} settings`;
  }
}

function same(a: number[], b: number[]) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

//==============================================================================
export interface SavedScenes {
  scenes: { name: string; values: Record<string, number> }[];
  active: number;
  glide: number;
}

/**
 * Named snapshots of the Live sound (every parameter but the input gain) for the parts of a
 * song. Recalling one glides there: knobs move over the glide time, effects that come on
 * switch on at the start, effects that go off switch off at the end, choices change at once.
 */
export class Scenes {
  static readonly maxScenes = 8;

  onChange: () => void = () => {};
  private list: SavedScenes["scenes"] = [];
  private active = -1;
  private glideSeconds = 0.5;
  private moves: { id: string; from: number; to: number; target: number; atEnd: boolean }[] = [];
  private glideTime = 0;
  private glideLength = 0;
  private lastTick = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly params: ParameterAccess,
    private readonly now: () => number = () => performance.now(),
  ) {}

  get gliding(): boolean {
    return this.moves.length > 0;
  }

  save(): SavedScenes {
    return { scenes: this.list.map((s) => ({ name: s.name, values: { ...s.values } })), active: this.active, glide: this.glideSeconds };
  }

  restore(saved: Partial<SavedScenes> | undefined): void {
    this.finishGlide();
    this.list = Array.isArray(saved?.scenes)
      ? saved.scenes.slice(0, Scenes.maxScenes).map((s) => ({ name: String(s.name ?? "Scene").slice(0, 40), values: { ...(s.values ?? {}) } }))
      : [];
    this.active = typeof saved?.active === "number" && saved.active < this.list.length ? saved.active : -1;
    this.glideSeconds = typeof saved?.glide === "number" ? Math.min(10, Math.max(0, saved.glide)) : 0.5;
  }

  describe() {
    return {
      scenes: this.list.map(({ name }) => ({ name })),
      active: this.active,
      modified: this.modified(),
      glide: this.glideSeconds,
      gliding: this.gliding,
      max: Scenes.maxScenes,
    };
  }

  /** The desktop's "scenes" native function. */
  handle(action: string, options: Record<string, unknown> = {}) {
    const index = typeof options.index === "number" ? options.index : -1;
    const before = JSON.stringify(this.save());
    if (action === "add") this.add(String(options.name ?? ""));
    if (action === "update") this.update(index);
    if (action === "rename") this.rename(index, String(options.name ?? ""));
    if (action === "remove") this.remove(index);
    if (action === "recall") this.recall(index);
    if (action === "step") this.step(typeof options.delta === "number" ? options.delta : 1);
    if (action === "glide") this.glideSeconds = Math.min(10, Math.max(0, Number(options.seconds ?? 0.5) || 0));
    if (JSON.stringify(this.save()) !== before) this.onChange();
    return this.describe();
  }

  add(name = ""): number {
    if (this.list.length >= Scenes.maxScenes) return -1;
    this.list.push({ name: name.trim().slice(0, 40) || `Scene ${this.list.length + 1}`, values: this.capture() });
    this.active = this.list.length - 1;
    return this.active;
  }

  update(index: number): void {
    const scene = this.list[index];
    if (!scene) return;
    scene.values = this.capture();
    this.active = index;
  }

  rename(index: number, name: string): void {
    const scene = this.list[index];
    if (scene && name.trim()) scene.name = name.trim().slice(0, 40);
  }

  remove(index: number): void {
    if (index < 0 || index >= this.list.length) return;
    this.list.splice(index, 1);
    this.active = this.active === index ? -1 : this.active > index ? this.active - 1 : this.active;
  }

  step(delta: number): void {
    const count = this.list.length;
    if (!count) return;
    this.recall(this.active < 0 ? (delta > 0 ? 0 : count - 1) : (((this.active + delta) % count) + count) % count);
  }

  recall(index: number): void {
    const scene = this.list[index];
    if (!scene) return;
    this.finishGlide(); // a glide already running ends where it was going first
    this.active = index;

    for (const id of this.sceneIds()) {
      const target = scene.values[id];
      if (target === undefined) continue; // a parameter newer than the scene keeps its value
      const info = this.params.info[id]!;
      const from = toNormalised(info, this.params.get(id));
      const to = toNormalised(info, target);
      if (Math.abs(to - from) < 1e-5) continue;
      if (info.choices || (info.bool && to > 0.5)) {
        this.params.set(id, fromNormalised(info, to)); // choices and effects coming on: now
        continue;
      }
      this.moves.push({ id, from, to, target, atEnd: Boolean(info.bool) });
    }

    this.glideTime = 0;
    this.glideLength = this.glideSeconds;
    this.lastTick = this.now();
    if (this.glideLength <= 0) this.advance(0);
    else if (this.moves.length && !this.timer) this.timer = setInterval(() => this.tickGlide(), 1000 / 60);
  }

  /** Runs the glide forward (the timer does it in real time; tests call it). */
  advance(seconds: number): void {
    if (!this.moves.length) return this.stopTimer();
    this.glideTime += seconds;
    const done = this.glideTime >= this.glideLength;
    const t = done ? 1 : this.glideTime / this.glideLength;
    const eased = t * t * (3 - 2 * t);
    for (const move of this.moves) {
      const info = this.params.info[move.id]!;
      if (done) this.params.set(move.id, move.target); // exactly the saved value
      else if (!move.atEnd) this.params.set(move.id, fromNormalised(info, move.from + (move.to - move.from) * eased));
    }
    if (done) {
      this.moves = [];
      this.stopTimer();
    }
  }

  private tickGlide() {
    const now = this.now();
    this.advance((now - this.lastTick) / 1000);
    this.lastTick = now;
  }

  private finishGlide() {
    if (this.moves.length) this.advance(this.glideLength);
  }

  private stopTimer() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private modified(): boolean {
    const scene = this.list[this.active];
    if (!scene) return false;
    return this.sceneIds().some((id) => {
      const saved = scene.values[id];
      const info = this.params.info[id]!;
      return saved !== undefined && Math.abs(toNormalised(info, saved) - toNormalised(info, this.params.get(id))) > 0.002;
    });
  }

  private sceneIds() {
    return this.params.ids.filter((id) => id !== "inputGain"); // the mic's level belongs to the room
  }

  private capture(): Record<string, number> {
    return Object.fromEntries(this.sceneIds().map((id) => [id, this.params.get(id)]));
  }
}
