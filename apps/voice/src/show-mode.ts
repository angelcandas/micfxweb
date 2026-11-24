// Show mode on the web (plan section 9, point 10): the desktop's Stage view (big lyrics, next
// song, Page Up / Page Down) goes full screen and keeps the screen awake while it's open, and
// page-turner pedals that send arrow keys step through the songs too.

type WakeLock = { release(): Promise<void>; addEventListener(type: "release", listener: () => void): void };

export function addShowMode() {
  const stage = document.querySelector<HTMLElement>(".stage-view");
  if (!stage) return;
  let lock: WakeLock | undefined;
  let wantLock = false;

  const keepAwake = async () => {
    const wakeLock = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLock> } }).wakeLock;
    if (!wantLock || lock || !wakeLock) return;
    try {
      lock = await wakeLock.request("screen");
      lock.addEventListener("release", () => (lock = undefined));
    } catch {
      // not allowed (battery saver, or the page isn't visible): the screen may sleep
    }
    stage.dataset.awake = String(Boolean(lock));
  };
  // A wake lock ends when the tab is hidden: taken again on return.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void keepAwake();
  });

  const full = Object.assign(document.createElement("button"), { type: "button", className: "tool web-stage-full", textContent: "Full screen" });
  full.title = "Fill the screen (Esc leaves full screen, then the stage view)";
  full.addEventListener("click", () => void toggleFullscreen());
  stage.querySelector(".stage-close")?.before(full);
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    } catch {
      // not allowed here (an iPhone, or no click): the stage view stays in the window
    }
  };
  document.addEventListener("fullscreenchange", () => (full.textContent = document.fullscreenElement ? "Leave full screen" : "Full screen"));

  // Opening and closing the stage view (the desktop's code shows and hides it).
  const opened = () => {
    wantLock = true;
    void keepAwake();
    if (!document.fullscreenElement) void toggleFullscreen();
  };
  const closed = () => {
    wantLock = false;
    void lock?.release();
    lock = undefined;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  };
  new MutationObserver(() => (stage.hidden ? closed() : opened())).observe(stage, { attributes: true, attributeFilter: ["hidden"] });

  // Page turners that send arrows: right / down for the next song, left / up for the one before.
  document.addEventListener("keydown", (event) => {
    if (stage.hidden || event.altKey || event.ctrlKey || event.metaKey) return;
    const key = { ArrowRight: "PageDown", ArrowDown: "PageDown", ArrowLeft: "PageUp", ArrowUp: "PageUp" }[event.key];
    if (!key) return;
    event.preventDefault();
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}
