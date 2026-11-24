// Sending things between MicFX Voice and MicFX DAW (plan point 28). The two apps live on
// different subdomains, so they don't share browser storage: the sender opens the other app in
// a window ("hand-off window") and, once it says it's ready, posts the items to it.
//
//   sender                               receiver (opened with ?handoff=<id>)
//   window.open(partner?handoff=id) ──►  loads, then  opener.postMessage(ready{id})
//   on ready from the partner's origin:
//   postMessage(items{id, items}) ─────►  checks the origin and id, takes the items
//                                  ◄────  done{id, ok, message}
//
// MicFX DAW's own pages are cross-origin isolated, so it receives on handoff.html (which keeps
// the items for the DAW page in the browser's storage) and sends from it too.
//
// Only the partner app's origin is trusted: micfxvoice.<domain> for micfxdaw.<domain> and
// back (on pages.dev or the custom domain), or any localhost port while developing.

export type AppName = "voice" | "daw";

export type HandoffItem =
  | { kind: "audio"; name: string; data: ArrayBuffer; role?: "take" | "backing" | "mix" | "stem" }
  | { kind: "midiMappings"; mappings: { source: "cc" | "note" | "program"; channel: number; number: number; target: string }[] };

export interface HandoffPayload { from: AppName; items: HandoffItem[]; title?: string }

interface Ready { type: "micfx-handoff-ready"; id: string }
interface Items { type: "micfx-handoff"; id: string; payload: HandoffPayload }
interface Done { type: "micfx-handoff-done"; id: string; ok: boolean; message?: string }

const MAX_BYTES = 512 * 1024 * 1024;
const AUDIO = /\.(wav|aiff?|flac|mp3|ogg|m4a|webm)$/i;

const isLocal = (host: string) => host === "localhost" || host === "127.0.0.1";

/** The other app's hand-off address, from this app's: micfxdaw.example.com <-> micfxvoice.example.com.
 * The DAW takes hand-offs on handoff.html: its own pages are cross-origin isolated (COOP), which
 * cuts the link to the window that opened them, so that page alone is served without it. */
export function partnerUrl(self: AppName, location: { protocol: string; host: string; hostname: string }, override?: string): string {
  if (override) return override;
  const other: AppName = self === "voice" ? "daw" : "voice";
  const page = other === "daw" ? "handoff.html" : "";
  if (isLocal(location.hostname)) return `${location.protocol}//${location.hostname}:${other === "voice" ? 4173 : 4175}/${page}`;
  const host = location.host.replace(new RegExp(`^micfx${self}(?=[.-])`), `micfx${other}`);
  return `${location.protocol}//${host}/${page}`;
}

/** Whether a message's origin is the partner app's. */
export function isPartnerOrigin(self: AppName, origin: string, location: { protocol: string; host: string; hostname: string }, override?: string): boolean {
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  if (isLocal(location.hostname) && isLocal(url.hostname)) return true;
  return url.origin === new URL(partnerUrl(self, location, override)).origin;
}

/** Checks what came in: only known kinds, audio files by name, a size limit. */
export function validPayload(payload: unknown): payload is HandoffPayload {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as HandoffPayload;
  if ((p.from !== "voice" && p.from !== "daw") || !Array.isArray(p.items) || p.items.length === 0 || p.items.length > 64) return false;
  let bytes = 0;
  for (const item of p.items) {
    if (item.kind === "audio") {
      if (typeof item.name !== "string" || !AUDIO.test(item.name) || !(item.data instanceof ArrayBuffer)) return false;
      bytes += item.data.byteLength;
    } else if (item.kind === "midiMappings") {
      if (!Array.isArray(item.mappings) || item.mappings.length > 512) return false;
    } else return false;
  }
  return bytes <= MAX_BYTES;
}

const newId = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/[^\w-]/g, "");

/** Opens the partner app and sends it the items. Resolves with its answer. Call it from a
 * click (browsers block windows opened otherwise). */
export function sendToPartner(self: AppName, payload: HandoffPayload, options: { override?: string; timeoutMs?: number } = {}): Promise<{ ok: boolean; message?: string }> {
  const id = newId();
  const url = new URL(partnerUrl(self, location, options.override));
  url.searchParams.set("handoff", id);
  const target = window.open(url.href, `micfx-${self === "voice" ? "daw" : "voice"}`);
  if (!target) return Promise.resolve({ ok: false, message: "The browser blocked the window. Allow pop-ups for this site and try again." });

  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve({ ok: false, message: "The other app didn't answer." }); }, options.timeoutMs ?? 60_000);
    const cleanup = () => { clearTimeout(timer); window.removeEventListener("message", onMessage); };
    const onMessage = (event: MessageEvent<Ready | Done>) => {
      if (event.source !== target || !isPartnerOrigin(self, event.origin, location, options.override)) return;
      const data = event.data;
      if (data?.id !== id) return;
      if (data.type === "micfx-handoff-ready") {
        const transfer = payload.items.flatMap((item) => (item.kind === "audio" ? [item.data] : []));
        target.postMessage({ type: "micfx-handoff", id, payload } satisfies Items, event.origin, transfer);
      } else if (data.type === "micfx-handoff-done") {
        cleanup();
        resolve({ ok: data.ok, message: data.message });
      }
    };
    window.addEventListener("message", onMessage);
  });
}

/** In the app that was opened for a hand-off: says it's ready, takes the items, answers.
 * Returns false when this page wasn't opened for one. */
export function receiveFromPartner(self: AppName, take: (payload: HandoffPayload) => Promise<{ ok: boolean; message?: string }>, options: { override?: string } = {}): boolean {
  const id = new URLSearchParams(location.search).get("handoff");
  const opener = window.opener as Window | null;
  if (!id || !opener) return false;

  // The address stays clean (a reload doesn't ask again).
  const clean = new URL(location.href);
  clean.searchParams.delete("handoff");
  history.replaceState(history.state, "", clean.href);

  const onMessage = async (event: MessageEvent<Items>) => {
    if (event.source !== opener || !isPartnerOrigin(self, event.origin, location, options.override)) return;
    const data = event.data;
    if (data?.type !== "micfx-handoff" || data.id !== id) return;
    window.removeEventListener("message", onMessage);
    let answer: { ok: boolean; message?: string };
    if (!validPayload(data.payload)) answer = { ok: false, message: "That wasn't something MicFX can take." };
    else {
      try { answer = await take(data.payload); } catch (error) { answer = { ok: false, message: error instanceof Error ? error.message : String(error) }; }
    }
    opener.postMessage({ type: "micfx-handoff-done", id, ...answer } satisfies Done, event.origin);
  };
  window.addEventListener("message", onMessage);
  // The ready signal carries nothing but the id; the items go only to the partner's origin.
  opener.postMessage({ type: "micfx-handoff-ready", id } satisfies Ready, "*");
  return true;
}
