// A few helpers for building the Capture screens.
export type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (key in node && key !== "list") (node as unknown as Record<string, unknown>)[key] = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

export function formatTime(seconds: number, tenths = true): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return tenths ? `${m}:${rest.toFixed(1).padStart(4, "0")}` : `${m}:${Math.floor(rest).toString().padStart(2, "0")}`;
}

/** A bottom sheet: closes on the backdrop or Escape. */
export function sheet(title: string, ...content: Child[]): HTMLDialogElement {
  const dialog = el("dialog", { class: "sheet", "aria-label": title }, el("h2", {}, title), ...content);
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

let toastTimer = 0;
export function toast(message: string, action?: { label: string; run: () => void }, ms = 8000): void {
  document.querySelector(".toast")?.remove();
  clearTimeout(toastTimer);
  const node = el("div", { class: "toast", role: "status" }, el("span", {}, message));
  if (action) node.append(el("button", { type: "button", onclick: () => { clearTimeout(toastTimer); node.remove(); action.run(); } }, action.label));
  document.body.append(node);
  toastTimer = window.setTimeout(() => node.remove(), ms);
}

export function drawBars(canvas: HTMLCanvasElement, bars: number[], options: { played?: number; color?: string; playedColor?: string; scale?: number; fromEnd?: boolean } = {}): void {
  const ratio = devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * ratio)) { canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio); }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const step = 4;
  const slots = Math.floor(w / step);
  const shown = options.fromEnd ? bars.slice(-slots) : bars;
  const count = options.fromEnd ? slots : Math.min(slots, shown.length || slots);
  const color = options.color ?? "#98a1b8", playedColor = options.playedColor ?? "#8c7bff";
  for (let i = 0; i < count; i++) {
    const index = options.fromEnd ? i - (slots - shown.length) : Math.floor((i * shown.length) / count);
    const value = index >= 0 ? (shown[index] ?? 0) / (options.scale ?? 100) : 0;
    const bar = Math.max(2, Math.min(1, value) * h);
    ctx.fillStyle = options.played !== undefined && i / count <= options.played ? playedColor : color;
    ctx.fillRect(i * step, (h - bar) / 2, 2.4, bar);
  }
}
