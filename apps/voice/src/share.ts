// A sound as a link (plan section 9, point 4): the values that differ from the defaults and
// the chain's order, in the address after "#sound=", so it opens in anyone's browser without
// a file or a server. Nothing is sent anywhere: the part after "#" stays in the browser.

export interface SharedSound {
  values: Record<string, number>;
  order?: string[];
  name?: string;
}

const KEY = "sound";

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** Four significant digits: plenty for a knob, and short. */
const short = (v: number) => Number(v.toPrecision(4));

/** The part after "#" for this sound. */
export function soundHash(values: Record<string, number>, defaults: Record<string, number>, order: string[], defaultOrder: string[], name?: string): string {
  const changed: Record<string, number> = {};
  for (const [id, value] of Object.entries(values)) {
    if (id === "inputGain" || !Number.isFinite(value)) continue; // the mic's level is the listener's own
    if (id in defaults && Math.abs(value - defaults[id]!) < 1e-6) continue;
    changed[id] = short(value);
  }
  const payload: { v: 1; s: Record<string, number>; o?: string[]; n?: string } = { v: 1, s: changed };
  if (order.join(",") !== defaultOrder.join(",")) payload.o = order;
  if (name) payload.n = name.slice(0, 60);
  return `${KEY}=${toBase64Url(JSON.stringify(payload))}`;
}

/** The sound in an address's "#…", or undefined when there's none (or it's broken). */
export function readSoundHash(hash: string, known: (id: string) => boolean): SharedSound | undefined {
  const match = /(?:^#?|&)sound=([A-Za-z0-9_-]+)/.exec(hash);
  if (!match) return undefined;
  try {
    const payload = JSON.parse(fromBase64Url(match[1]!)) as { v?: number; s?: Record<string, unknown>; o?: unknown; n?: unknown };
    if (payload.v !== 1 || typeof payload.s !== "object" || !payload.s) return undefined;
    const values: Record<string, number> = {};
    for (const [id, value] of Object.entries(payload.s)) if (known(id) && Number.isFinite(Number(value))) values[id] = Number(value);
    const order = Array.isArray(payload.o) ? payload.o.map(String) : undefined;
    const name = typeof payload.n === "string" ? payload.n : undefined;
    return { values, order, name };
  } catch {
    return undefined;
  }
}
