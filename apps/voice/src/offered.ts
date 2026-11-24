// A file dropped on the page (drop.ts) stands in for the next file picker, so dropping goes
// through the same steps as the app's own "Open…" buttons.
let offered: { file: File; until: number } | undefined;

export function offerFile(file: File) {
  offered = { file, until: performance.now() + 3000 };
}

/** The dropped file, once, if one is waiting. */
export function takeOffered(): File | undefined {
  const file = offered && performance.now() < offered.until ? offered.file : undefined;
  offered = undefined;
  return file;
}
