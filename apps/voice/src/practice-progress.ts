// The pass report's web additions (plan section 9, points 15 and 19):
// - Progress: this song's scores pass by pass as a small chart, with "best this week".
// - Result card: a picture of the score, what you sang against the melody, and the song's
//   name, to save or share.
import { pageLanguage, translate } from "./i18n";
import { chartPoints, progress, type Pass } from "./practice-history";

/** The card is drawn, not on the page, so it's translated here. */
const t = (text: string) => (pageLanguage() === "es" ? (translate(text) ?? text) : text);

export interface CardData {
  name: string;
  key: string;
  shift: { speed: number; semitones: number };
  /** The melody as it plays: start, end, midi, phrase for each note. */
  notes: number[];
  /** What you sang: time, midi pairs. */
  trail: number[];
  report: Record<string, unknown>;
}

export interface PracticeProgressHost {
  history(): { name: string; passes: Pass[] } | undefined;
  card(): CardData | undefined;
}

const SVG = "http://www.w3.org/2000/svg";
const scoreClass = (score: number) => (score >= 80 ? "is-good" : score >= 55 ? "is-close" : "is-off");
const COLOURS = { good: "#3ddc97", close: "#f5c451", off: "#ff6b6b" };
const colourOf = (score: number) => (score >= 80 ? COLOURS.good : score >= 55 ? COLOURS.close : COLOURS.off);

export function addPracticeProgress(host: PracticeProgressHost) {
  const decorate = (report: Element) => {
    if (report.hasAttribute("hidden") || report.querySelector(".web-progress") || !report.querySelector(".practice-report-head")) return;
    const block = progressBlock(host);
    // (a picture only of a pass with a score)
    if (!report.querySelector(".practice-report-score")) block.querySelector(".web-card-button")?.remove();
    // After the score and its tips, before the heat map and the weak phrases.
    const note = report.querySelector(".practice-report-note");
    if (note) note.after(block);
    else report.append(block);
  };
  new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target as Element;
      if (target.classList?.contains("practice-report")) decorate(target);
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });
}

function progressBlock(host: PracticeProgressHost): HTMLElement {
  const block = Object.assign(document.createElement("div"), { className: "web-progress" });
  const history = host.history();
  const passes = history?.passes ?? [];
  block.append(Object.assign(document.createElement("div"), { className: "practice-report-sub", textContent: "Your progress" }));
  if (passes.length) {
    const p = progress(passes, Date.now());
    const parts = [`Best this week ${Math.round(p.bestWeek ?? 0)}`, `best ever ${Math.round(p.best ?? 0)}`, p.count === 1 ? "1 pass" : `${p.count} passes`];
    block.append(chart(passes), Object.assign(document.createElement("p"), { className: "practice-report-note web-progress-line", textContent: parts.join(" · ") }));
    if (p.trend !== undefined && Math.abs(p.trend) >= 3)
      block.append(Object.assign(document.createElement("p"), {
        className: "practice-report-note",
        textContent: p.trend > 0 ? `Up ${Math.round(p.trend)} on your last few passes.` : `Down ${Math.round(-p.trend)} on your last few passes.`,
      }));
  } else {
    block.append(Object.assign(document.createElement("p"), { className: "practice-report-note", textContent: "Sing the whole song through and each pass shows here." }));
  }
  const save = Object.assign(document.createElement("button"), {
    type: "button",
    className: "tool web-card-button",
    textContent: "Save as picture",
    title: "A picture of this pass: the score, what you sang against the melody, and the song's name",
  });
  save.addEventListener("click", () => {
    const data = host.card();
    if (data) void saveCard(data);
  });
  block.append(save);
  return block;
}

function chart(passes: Pass[]): SVGSVGElement {
  const width = 300;
  const height = 64;
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "web-progress-chart");
  svg.setAttribute("viewBox", `-4 -4 ${width + 8} ${height + 8}`);
  svg.setAttribute("role", "img");
  const shown = passes.slice(-30);
  svg.setAttribute("aria-label", `Scores of the last ${shown.length} passes: ${shown.map((p) => Math.round(p.score)).join(", ")}`);
  for (const level of [55, 80]) {
    const line = document.createElementNS(SVG, "line");
    const y = String(height - (level / 100) * height);
    Object.entries({ x1: "0", x2: String(width), y1: y, y2: y, class: "web-progress-grid" }).forEach(([k, v]) => line.setAttribute(k, v));
    svg.append(line);
  }
  const points = chartPoints(passes, width, height);
  const path = document.createElementNS(SVG, "polyline");
  path.setAttribute("points", points.map((p) => p.join(",")).join(" "));
  path.setAttribute("class", "web-progress-line-path");
  svg.append(path);
  points.forEach(([x, y], i) => {
    const dot = document.createElementNS(SVG, "circle");
    Object.entries({ cx: String(x), cy: String(y), r: i === points.length - 1 ? "3.5" : "2.2", class: `web-progress-dot ${scoreClass(shown[i]!.score)}` }).forEach(([k, v]) => dot.setAttribute(k, v));
    const title = document.createElementNS(SVG, "title");
    title.textContent = `${Math.round(shown[i]!.score)} · ${new Date(shown[i]!.at).toLocaleDateString()}`;
    dot.append(title);
    svg.append(dot);
  });
  return svg;
}

/** The result card as a PNG. */
export async function cardImage(data: CardData): Promise<Blob> {
  const W = 1200;
  const H = 630;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d")!;
  const font = (weight: number, size: number) => `${weight} ${size}px Inter, "Segoe UI", system-ui, sans-serif`;
  const background = g.createLinearGradient(0, 0, W, H);
  background.addColorStop(0, "#151a26");
  background.addColorStop(1, "#0b0d13");
  g.fillStyle = background;
  g.fillRect(0, 0, W, H);

  const report = data.report;
  const score = Number(report.score) || 0;
  const colour = colourOf(score);

  // The song and the brand.
  g.fillStyle = "#8f98ad";
  g.font = font(600, 22);
  g.fillText(t("MicFX Voice · Practice"), 60, 70);
  g.fillStyle = "#eef1f7";
  g.font = font(750, 46);
  g.fillText(fit(g, data.name, 760), 60, 128);
  g.fillStyle = "#8f98ad";
  g.font = font(500, 22);
  const shift = [data.shift.semitones ? `${data.shift.semitones > 0 ? "+" : ""}${data.shift.semitones} semitones` : "", data.shift.speed !== 1 ? `${Math.round(data.shift.speed * 100)}% speed` : ""].filter(Boolean);
  g.fillText([data.key, ...shift, new Date().toLocaleDateString()].filter(Boolean).join(" · "), 60, 166);

  // The score.
  g.textAlign = "right";
  g.fillStyle = colour;
  g.font = font(800, 140);
  g.fillText(String(Math.round(score)), W - 60, 160);
  g.textAlign = "left";

  // Pitch, timing, steadiness.
  const meters: [string, number][] = [["Pitch", Number(report.pitch) || 0], ["Timing", Number(report.timing) || 0], ["Steadiness", Number(report.steady) || 0]];
  meters.forEach(([label, value], i) => {
    const x = 60 + i * 360;
    const y = 220;
    g.fillStyle = "#8f98ad";
    g.font = font(600, 20);
    g.fillText(t(label), x, y);
    g.fillStyle = "#eef1f7";
    g.textAlign = "right";
    g.fillText(String(Math.round(value * 100)), x + 320, y);
    g.textAlign = "left";
    roundRect(g, x, y + 12, 320, 10, 5, "#05070b");
    roundRect(g, x, y + 12, Math.max(10, 320 * Math.min(1, value)), 10, 5, colourOf(value * 100));
  });

  // What you sang against the melody.
  const box = { x: 60, y: 280, w: W - 120, h: 270 };
  roundRect(g, box.x, box.y, box.w, box.h, 16, "#080a10");
  drawTrail(g, data, { x: box.x + 16, y: box.y + 16, w: box.w - 32, h: box.h - 32 });

  g.fillStyle = "#8f98ad";
  g.font = font(500, 18);
  const covered = Number(report.total) ? t(`${report.scored} of ${report.total} phrases sung`) : "";
  g.fillText([t("Grey: the melody"), t("colour: your voice"), covered].filter(Boolean).join(" · "), 60, 590);

  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("No picture"))), "image/png"));
}

function drawTrail(g: CanvasRenderingContext2D, data: CardData, box: { x: number; y: number; w: number; h: number }) {
  const notes: { start: number; end: number; pitch: number }[] = [];
  for (let i = 0; i + 3 < data.notes.length; i += 4) notes.push({ start: data.notes[i]!, end: data.notes[i + 1]!, pitch: data.notes[i + 2]! });
  const sung: [number, number][] = [];
  for (let i = 0; i + 1 < data.trail.length; i += 2) sung.push([data.trail[i]!, data.trail[i + 1]!]);
  if (!notes.length) return;
  // The part of the song that was sung (the whole song when nothing was).
  const from = sung.length ? Math.max(notes[0]!.start, sung[0]![0] - 2) : notes[0]!.start;
  const to = sung.length ? Math.min(notes.at(-1)!.end, sung.at(-1)![0] + 2) : notes.at(-1)!.end;
  const shown = notes.filter((n) => n.end > from && n.start < to);
  const pitches = [...shown.map((n) => n.pitch), ...sung.filter(([t]) => t >= from && t <= to).map(([, m]) => m)];
  if (!pitches.length) return;
  const low = Math.min(...pitches) - 2;
  const high = Math.max(...pitches) + 2;
  const x = (t: number) => box.x + ((t - from) / Math.max(0.1, to - from)) * box.w;
  const y = (m: number) => box.y + box.h - ((m - low) / Math.max(1, high - low)) * box.h;
  const thick = Math.max(4, Math.min(12, box.h / (high - low)));
  g.fillStyle = "rgba(143, 152, 173, 0.35)";
  for (const n of shown) roundRect(g, x(Math.max(from, n.start)), y(n.pitch) - thick / 2, Math.max(2, x(Math.min(to, n.end)) - x(Math.max(from, n.start))), thick, thick / 2);

  // Your voice, coloured by how close it is to the note under it.
  g.lineWidth = 3;
  g.lineCap = "round";
  let previous: [number, number] | undefined;
  let k = 0;
  for (const [t, m] of sung) {
    if (t < from || t > to) continue;
    while (k < notes.length - 1 && notes[k]!.end < t) k++;
    const note = notes[k]!;
    const near = note.start <= t + 0.05 && t <= note.end + 0.05 ? Math.abs(m - note.pitch) : undefined;
    g.strokeStyle = near === undefined ? "#7aa2ff" : near <= 0.35 ? COLOURS.good : near <= 0.8 ? COLOURS.close : COLOURS.off;
    if (previous && t - previous[0] < 0.25 && Math.abs(m - previous[1]) < 3) {
      g.beginPath();
      g.moveTo(x(previous[0]), y(previous[1]));
      g.lineTo(x(t), y(m));
      g.stroke();
    }
    previous = [t, m];
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill?: string) {
  if (fill) g.fillStyle = fill;
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  g.fill();
}

function fit(g: CanvasRenderingContext2D, text: string, width: number): string {
  if (g.measureText(text).width <= width) return text;
  let cut = text;
  while (cut.length > 1 && g.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** Shares the card where the browser shares files (phones), else downloads it. */
async function saveCard(data: CardData) {
  const blob = await cardImage(data);
  const name = `${data.name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "MicFX"} - ${Math.round(Number(data.report.score) || 0)}.png`;
  const file = new File([blob], name, { type: "image/png" });
  if (matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: data.name });
      return;
    } catch {
      // cancelled: save it instead
    }
  }
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}
