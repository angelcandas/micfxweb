// MicFX Voice <-> MicFX DAW (plan point 28). Takes sent from MicFX Voice arrive through
// handoff.html, which keeps them in storage and opens the DAW with ?inbox=<id>; each becomes a
// track. The DAW sends its mix to MicFX Voice (to sing or practise over) the other way.
import type { HandoffPayload } from "@micfx/handoff";
import type { DawEngine } from "./engine";
import { putHandoff, takeHandoff } from "./inbox";

const FOLDER = (engine: DawEngine) => `${engine.home}/Music/From MicFX Voice`;
export const HANDOFF_EXPORTS = "/tmp/handoff";

/** What MicFX Voice sent, if the page was opened for it: a sentence for the person. */
export async function takeInbox(engine: DawEngine): Promise<string | undefined> {
  const params = new URLSearchParams(location.search);
  const id = params.get("inbox")?.replace(/[^\w-]/g, "");
  if (!id) return undefined;
  const clean = new URL(location.href);
  clean.searchParams.delete("inbox");
  history.replaceState(history.state, "", clean.href);

  const payload = await takeHandoff(`in-${id}`);
  if (!payload) return undefined;
  const existing = new Set((await engine.list(FOLDER(engine))).map((e) => e.name));
  let tracks = 0;
  let mappings = 0;
  for (const item of payload.items) {
    if (item.kind === "audio") {
      let name = item.name.replace(/[/\\]/g, "_");
      const dot = name.lastIndexOf(".");
      for (let n = 2; existing.has(name); n++) name = `${item.name.slice(0, dot)} ${n}${item.name.slice(dot)}`;
      existing.add(name);
      const path = `${FOLDER(engine)}/${name}`;
      await engine.writeFile(path, item.data);
      const added = (await engine.call("daw", ["importFile", { file: path, track: -1, start: 0 }])) as { ok?: boolean };
      if (added?.ok !== false) tracks++;
    } else if (item.kind === "midiMappings" && item.mappings.length) {
      await engine.call("midi", ["set", { mappings: item.mappings }]);
      mappings = item.mappings.length;
    }
  }
  const parts = [tracks ? `${tracks} track${tracks === 1 ? "" : "s"}` : "", mappings ? `${mappings} MIDI mapping${mappings === 1 ? "" : "s"}` : ""].filter(Boolean);
  return parts.length ? `Got ${parts.join(" and ")} from MicFX Voice` : undefined;
}

/** Sends the song's mix to MicFX Voice. Call from a click: the hand-off window opens now, and
 * the mix follows once it's rendered. */
export function sendMixToVoice(engine: DawEngine, projectName: string, waitForExport: () => Promise<string | undefined>) {
  const id = `${Date.now()}`;
  const relay = window.open(`handoff.html?send=${id}`, "micfx-handoff");
  return (async () => {
    const started = (await engine.call("daw", ["export", { kind: "mix", format: "wav", bitDepth: 16, folder: HANDOFF_EXPORTS, name: projectName, overwrite: true, handoff: true }])) as { ok?: boolean; error?: string };
    if (started?.ok === false) { relay?.close(); throw new Error(started.error ?? "Couldn't render the mix."); }
    const path = await waitForExport();
    if (!path) { relay?.close(); throw new Error("Couldn't render the mix."); }
    const payload: HandoffPayload = { from: "daw", title: `${projectName} (mix)`, items: [{ kind: "audio", name: `${projectName}.wav`, data: await engine.readFile(path), role: "mix" }] };
    await putHandoff(`out-${id}`, payload);
    await engine.remove(path).catch(() => {});
  })();
}
