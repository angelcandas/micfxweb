// Between MicFX Voice and MicFX DAW (plan point 28), over @micfx/handoff:
// - "Send to DAW" in the recorder sends the takes and the song to MicFX DAW, lined up at bar 1.
// - Opened by MicFX DAW (?handoff=<id>), Voice takes its mix as the backing track to sing over.
import { receiveFromPartner, sendToPartner, type HandoffItem } from "@micfx/handoff";
import type { Tracks } from "./tracks";

export interface HandoffHooks {
  tracks: Tracks;
  /** Says something in the app's status line. */
  notify(message: string, error?: boolean): void;
}

export function addSendToDaw(hooks: HandoffHooks) {
  const anchor = document.querySelector("footer.recorder .web-video-button") ?? document.querySelector("footer.recorder .record-dry");
  if (!anchor || document.querySelector(".web-send-daw")) return;
  const button = Object.assign(document.createElement("button"), {
    type: "button",
    className: "pill web-send-daw",
    textContent: "Send to DAW",
    title: "Open MicFX DAW with your takes and the song, lined up from bar 1, to edit and mix them",
  });
  anchor.after(button);
  const update = () => {
    button.disabled = !hooks.tracks.rows().length;
  };
  update();
  const previous = hooks.tracks.onChanged;
  hooks.tracks.onChanged = () => {
    previous();
    update();
  };

  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      // (quick: a browser lets a click open a window for a few seconds)
      const tracks = await hooks.tracks.handoffTracks();
      if (!tracks.length) return hooks.notify("Record a take or load a song first.", true);
      const items: HandoffItem[] = uniqueNames(tracks).map((t) => ({ kind: "audio", ...t }));
      hooks.notify("Opening MicFX DAW…");
      const answer = await sendToPartner("voice", { from: "voice", items, title: "From MicFX Voice" });
      hooks.notify(answer.ok ? (answer.message ?? "Sent to MicFX DAW.") : (answer.message ?? "MicFX DAW didn't take them."), !answer.ok);
    } catch (error) {
      hooks.notify(`Couldn't send them: ${error instanceof Error ? error.message : String(error)}`, true);
    } finally {
      update();
    }
  });
}

/** Opened by MicFX DAW to sing over its mix: the mix becomes the backing track. */
export function takeFromDaw(hooks: HandoffHooks): boolean {
  return receiveFromPartner("voice", async (payload) => {
    const audio = payload.items.filter((item): item is Extract<HandoffItem, { kind: "audio" }> => item.kind === "audio");
    const mix = audio.find((item) => item.role === "mix") ?? audio[0];
    if (!mix) return { ok: false, message: "Nothing to sing over came with it." };
    const file = new File([mix.data], mix.name, { type: mix.name.endsWith(".wav") ? "audio/wav" : "" });
    await hooks.tracks.replaceBacking(file);
    hooks.notify(`${mix.name.replace(/\.[^.]+$/, "")} from MicFX DAW is the backing track. Press record and sing.`);
    return { ok: true, message: "MicFX Voice has the mix as its backing track." };
  });
}

/** "Take 1.wav" twice becomes "Take 1.wav" and "Take 1 (2).wav". */
export function uniqueNames<T extends { name: string }>(items: T[]): T[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const key = item.name.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n === 1 ? item : { ...item, name: item.name.replace(/(\.[^.]+)?$/, (ext) => ` (${n})${ext}`) };
  });
}
