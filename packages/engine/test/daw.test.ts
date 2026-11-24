// daw.wasm (build-daw.sh) in Node: the desktop DAW, with its threads, behind DawHost's C API.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface DawModule {
  ccall(name: string, ret: string | null, types: string[], args: unknown[]): number;
  _micfx_daw_dispatch(): number;
  _micfx_daw_tick(): void;
  _malloc(size: number): number;
  _free(pointer: number): void;
  wasmMemory: WebAssembly.Memory;
}

let m: DawModule;
const pending = new Map<number, (value: unknown) => void>();
const events: string[] = [];
let nextId = 1;
let timers: ReturnType<typeof setInterval>[] = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (name: string, args: unknown[]): Promise<any> =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    m.ccall("micfx_daw_call", null, ["number", "string", "string"], [id, name, JSON.stringify(args)]);
  });
const daw = (command: string, args: object = {}) => call("daw", [command, args]);

function writeFile(path: string, bytes: Uint8Array) {
  const at = m._malloc(bytes.length);
  new Uint8Array(m.wasmMemory.buffer).set(bytes, at);
  const ok = m.ccall("micfx_daw_write", "number", ["string", "number", "number"], [path, at, bytes.length]);
  m._free(at);
  return ok === 1;
}

beforeAll(async () => {
  const url = new URL("../dist/daw.mjs", import.meta.url).href;
  const { default: createDawModule } = await import(/* @vite-ignore */ url);
  m = await createDawModule({
    onDawComplete: (id: number, json: string) => { pending.get(id)?.(JSON.parse(json)); pending.delete(id); },
    onDawEvent: (name: string) => events.push(name),
    onDawChooser: () => {},
    onDawClipboard: () => {},
    print: () => {},
    printErr: () => {},
  });
  m.ccall("micfx_daw_mount", "number", ["number"], [0]);
  m.ccall("micfx_daw_create", "number", ["number", "number"], [48000, 128]);
  timers = [setInterval(() => m._micfx_daw_dispatch(), 2), setInterval(() => m._micfx_daw_tick(), 33)];
}, 60_000);

afterAll(() => timers.forEach(clearInterval));

describe("daw.wasm", () => {
  it("answers the DAW screen's calls in DAW mode", async () => {
    await daw("mode", { daw: true });
    const session = await daw("session");
    expect(session.mode).toBe("daw");
    expect(session.tracks.length).toBeGreaterThan(0);
    const info = await call("getParameterInfo", []);
    expect(Object.keys(info).length).toBeGreaterThan(100);
  });

  it("imports a WAV and reads its audio", async () => {
    const wav = readFileSync(fileURLToPath(new URL("../../../apps/daw/e2e/voice.wav", import.meta.url)));
    expect(writeFile("/home/web/Music/voice.wav", wav)).toBe(true);
    const added = await daw("importFile", { file: "/home/web/Music/voice.wav" });
    expect(added.ok).toBe(true);
    expect(added.length).toBeCloseTo(2, 1);

    let peaks: number[] = [];
    for (let i = 0; i < 20 && peaks.length === 0; i++) {
      peaks = (await daw("peaks", { file: "/home/web/Music/voice.wav" }))?.peaks ?? [];
      if (!peaks.length) await new Promise((r) => setTimeout(r, 100));
    }
    // 16-bit WAVs decode (JUCE needs JUCE_LITTLE_ENDIAN on wasm).
    expect(Math.max(...peaks)).toBeGreaterThan(0.2);
  });

  it("saves a project file", async () => {
    const saved = await new Promise<unknown>((resolve) => {
      // "saveAs" asks the page for a folder: answer as the page would.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (m as any).onDawChooser = (id: number) => m.ccall("micfx_daw_chooser_result", null, ["number", "string"], [id, "/home/web/Documents/Test Song"]);
      void daw("saveAs").then(resolve);
    });
    expect(saved).toMatchObject({ ok: true });
    expect((await daw("session")).project.name).toBe("Test Song");
    const list = (path: string) => {
      const listed = m.ccall("micfx_daw_list", "number", ["string"], [path]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const names = (JSON.parse((m as any).UTF8ToString(listed)) as { name: string }[]).map((e) => e.name);
      m._free(listed);
      return names;
    };
    expect(list("/home/web/Documents")).toContain("Test Song.micfx");
  });

  it("sends the session and status to the page", () => {
    expect(events).toContain("dawSession");
    expect(events).toContain("dawStatus");
  });
});
