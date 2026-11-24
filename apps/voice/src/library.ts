// Your own presets in the browser: the desktop's preset library (src/PresetLibrary.h, files
// on disk) as one localStorage entry. Effect presets per effect, a default per effect, and
// whole Live sounds (every value and the order). Same "library" actions and answers.
import type { LiveEngine } from "@micfx/engine";

const KEY = "micfx.library";

interface Store {
  effects: Record<string, Record<string, Record<string, number>>>;
  defaults: Record<string, Record<string, number>>;
  sounds: Record<string, { values: Record<string, number>; order: string[] }>;
  imported?: boolean;
}

type Answer = { ok: boolean; error?: string };
const ok: Answer = { ok: true };
const fail = (error: string): Answer => ({ ok: false, error });

/** The desktop's PresetLibrary::safeName. */
export function safeName(name: unknown): string {
  let safe = String(name ?? "").trim().slice(0, 60).replace(/[/\\:*?"<>|]/g, "-").replace(/[\r\n\t]/g, "").trim();
  while (safe.startsWith(".")) safe = safe.slice(1);
  return safe.trim();
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

export function createLibrary(opts: {
  shadow: LiveEngine;
  /** Every parameter's value now. */
  values: () => Record<string, number>;
  /** Plays a saved sound: its values and its order. */
  apply: (values: Record<string, number>, order: string[]) => void;
}) {
  const switches = opts.shadow.valueInfo().filter((v) => v.isSwitch && v.module);
  const read = (): Store => {
    try {
      const parsed = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Store> | null;
      return { effects: parsed?.effects ?? {}, defaults: parsed?.defaults ?? {}, sounds: parsed?.sounds ?? {}, imported: parsed?.imported };
    } catch {
      return { effects: {}, defaults: {}, sounds: {} };
    }
  };
  const write = (store: Store): Answer => {
    try {
      localStorage.setItem(KEY, JSON.stringify(store));
      return ok;
    } catch {
      return fail("The browser's storage is full or blocked, so this couldn't be saved.");
    }
  };
  const numbers = (values: unknown) =>
    Object.fromEntries(Object.entries((values ?? {}) as Record<string, unknown>).filter(([, v]) => Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)]));

  return (action: string, a?: unknown, b?: unknown, c?: unknown): unknown => {
    const store = read();
    switch (action) {
      case "effects": {
        const result: Record<string, { name: string; values: Record<string, number> }[]> = {};
        for (const [kind, presets] of Object.entries(store.effects)) {
          const list = Object.entries(presets).map(([name, values]) => ({ name, values })).sort((x, y) => byName(x.name, y.name));
          if (list.length) result[kind] = list;
        }
        return result;
      }
      case "saveEffect": {
        const kind = safeName(a), name = safeName(b);
        if (!kind) return fail("Which effect is this preset for?");
        if (!name) return fail("Give the preset a name.");
        (store.effects[kind] ??= {})[name] = numbers(c);
        return write(store);
      }
      case "deleteEffect": {
        const kind = safeName(a), name = safeName(b);
        if (!store.effects[kind]?.[name]) return fail("It's already gone.");
        delete store.effects[kind]![name];
        return write(store);
      }
      case "renameEffect": {
        const kind = safeName(a), name = safeName(b), to = safeName(c);
        const presets = store.effects[kind];
        if (!presets?.[name]) return fail(`There's no preset called ${name}.`);
        if (!to) return fail("Give the preset a name.");
        if (to !== name && presets[to]) return fail(`There's already a preset called ${to}.`);
        presets[to] = presets[name]!;
        if (to !== name) delete presets[name];
        return write(store);
      }
      case "getDefault":
        return store.defaults[safeName(a)] ?? {};
      case "setDefault": {
        const kind = safeName(a);
        if (!kind) return fail("Which effect is this default for?");
        store.defaults[kind] = numbers(b);
        return write(store);
      }
      case "clearDefault": {
        const kind = safeName(a);
        if (!store.defaults[kind]) return fail("There was no default.");
        delete store.defaults[kind];
        return write(store);
      }
      case "chains":
        return Object.entries(store.sounds)
          .map(([name, sound]) => ({ name, effects: sound.order.filter((key) => isOn(sound.values, key)), live: true }))
          .sort((x, y) => byName(x.name, y.name));
      case "saveSound": {
        const name = safeName(a);
        if (!name) return fail("Give the sound a name.");
        store.sounds[name] = { values: opts.values(), order: opts.shadow.getOrder() };
        return write(store);
      }
      case "loadSound": {
        const sound = store.sounds[safeName(a)];
        if (!sound) return fail(`There's no sound called ${safeName(a)}.`);
        opts.apply(sound.values, sound.order);
        return ok;
      }
      case "deleteChain": {
        const name = safeName(a);
        if (!store.sounds[name]) return fail("It's already gone.");
        delete store.sounds[name];
        return write(store);
      }
      case "renameChain": {
        const name = safeName(a), to = safeName(b);
        if (!store.sounds[name]) return fail(`There's no sound called ${name}.`);
        if (!to) return fail("Give the sound a name.");
        if (to !== name && store.sounds[to]) return fail(`There's already a sound called ${to}.`);
        store.sounds[to] = store.sounds[name]!;
        if (to !== name) delete store.sounds[name];
        return write(store);
      }
      case "import": {
        // The old presets kept in the UI prefs ({ effectId: [{ name, values }] }), once.
        if (store.imported) return 0;
        let count = 0;
        try {
          const old = JSON.parse(String(a ?? "{}")) as Record<string, { name: string; values: Record<string, number> }[]>;
          for (const [kind, list] of Object.entries(old))
            for (const preset of list ?? []) {
              const name = safeName(preset.name);
              if (!name) continue;
              (store.effects[safeName(kind)] ??= {})[name] = numbers(preset.values);
              ++count;
            }
        } catch {
          // Nothing to import.
        }
        store.imported = true;
        write(store);
        return count;
      }
      case "factoryChains":
        return []; // the factory vocal chains need the desktop's ValueTree code: the DAW phase brings it
      default:
        return fail(`Unknown library action ${action}`);
    }
  };

  // Whether a module's switch is on in a sound's values.
  function isOn(values: Record<string, number>, key: string): boolean {
    return switches.some((v) => v.module === key && (values[v.id] ?? v.defaultValue) >= 0.5);
  }
}
