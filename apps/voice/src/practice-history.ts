// Progress over time (plan section 9, point 15): each whole pass of a song kept beside it
// (practice/<id>/history.json), for the chart on the pass report and "best this week".

export interface Pass {
  /** When it ended, ms since 1970. */
  at: number;
  score: number;
  pitch: number;
  timing: number;
  steady: number;
  /** Phrases scored, of all of them. */
  scored: number;
  total: number;
  /** As it played: speed (1 = as recorded) and key (semitones). */
  speed: number;
  semitones: number;
}

export const HISTORY = "history.json";
const MAX_PASSES = 300;
const WEEK = 7 * 24 * 3600 * 1000;

/** The pass from a report (the scorer's scoreReport), or none when it isn't a whole pass. */
export function passFrom(report: Record<string, unknown>, at: number, shift: { speed: number; semitones: number }): Pass | undefined {
  const number = (key: string) => (typeof report[key] === "number" && Number.isFinite(report[key]) ? (report[key] as number) : 0);
  if (report.looping || number("scored") <= 0) return undefined;
  return {
    at,
    score: round1(number("score")),
    pitch: round3(number("pitch")),
    timing: round3(number("timing")),
    steady: round3(number("steady")),
    scored: number("scored"),
    total: number("total"),
    speed: shift.speed,
    semitones: shift.semitones,
  };
}

export function addPass(passes: Pass[], pass: Pass): Pass[] {
  return [...passes, pass].slice(-MAX_PASSES);
}

export function parsePasses(text: string | undefined): Pass[] {
  try {
    const list = JSON.parse(text ?? "[]") as unknown;
    return Array.isArray(list) ? list.filter((p): p is Pass => typeof p?.at === "number" && typeof p?.score === "number") : [];
  } catch {
    return [];
  }
}

export interface Progress {
  count: number;
  best: number | undefined;
  /** The best of the last 7 days. */
  bestWeek: number | undefined;
  weekCount: number;
  /** The last pass's score less the average of the 5 before it. */
  trend: number | undefined;
}

export function progress(passes: Pass[], now: number): Progress {
  const week = passes.filter((p) => now - p.at < WEEK);
  const max = (list: Pass[]) => (list.length ? Math.max(...list.map((p) => p.score)) : undefined);
  const before = passes.slice(-6, -1);
  const last = passes.at(-1);
  return {
    count: passes.length,
    best: max(passes),
    bestWeek: max(week),
    weekCount: week.length,
    trend: last && before.length ? round1(last.score - before.reduce((sum, p) => sum + p.score, 0) / before.length) : undefined,
  };
}

/** The chart's line through the last `n` passes' scores (0-100), in a `width`×`height` box. */
export function chartPoints(passes: Pass[], width: number, height: number, n = 30): [number, number][] {
  const shown = passes.slice(-n);
  if (!shown.length) return [];
  const step = shown.length > 1 ? width / (shown.length - 1) : 0;
  return shown.map((p, i) => [round1(shown.length > 1 ? i * step : width / 2), round1(height - (Math.max(0, Math.min(100, p.score)) / 100) * height)]);
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

function round3(value: number) {
  return Math.round(value * 1000) / 1000;
}
