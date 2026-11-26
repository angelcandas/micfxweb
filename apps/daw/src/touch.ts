// Touch for the DAW on tablets (mobile plan, phase 4). The desktop screen is built for a mouse:
// right-click menus, scroll-wheel zoom. This adds the touch versions without changing it:
//  - press and hold for a moment = right-click (the menu opens where you hold)
//  - pinch = Ctrl + scroll wheel (zoom the timeline, the piano roll, the clip editor)
//  - the library starts folded on a small tablet, and the hint says "press and hold"
// It only runs for touch input (pointerType "touch"), so a mouse or a pen is untouched.

const HOLD_MS = 450;
const MOVE_PX = 10;

interface Touch { id: number; x: number; y: number; startX: number; startY: number; target: EventTarget | null }

/** The screen's width (the page's own can be wider while it loads). */
const screenWidth = () => Math.min(innerWidth, screen.width || innerWidth);

export const isTouchDevice = () => matchMedia("(pointer: coarse)").matches;

export function addTouchSupport() {
  if (!isTouchDevice()) return;
  document.body.classList.add("web-touch");
  const touches = new Map<number, Touch>();
  let holdTimer = 0;
  let swallowClickUntil = 0;
  let pinch: { distance: number } | undefined;

  const clearHold = () => { clearTimeout(holdTimer); holdTimer = 0; };

  const holdAt = (touch: Touch) => {
    const target = document.elementFromPoint(touch.x, touch.y) ?? (touch.target as Element | null);
    if (!target) return;
    navigator.vibrate?.(12);
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: touch.x, clientY: touch.y, button: 2, view: window }));
    // The finger is still down: its lift must not click what the menu put under it.
    swallowClickUntil = Number.POSITIVE_INFINITY;
  };

  document.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch") return;
    touches.set(event.pointerId, { id: event.pointerId, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, target: event.target });
    clearHold();
    if (touches.size === 1) {
      const only = [...touches.values()][0]!;
      holdTimer = window.setTimeout(() => holdAt(only), HOLD_MS);
    } else if (touches.size === 2) {
      const [a, b] = [...touches.values()] as [Touch, Touch];
      pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) };
    }
  }, { capture: true, passive: true });

  document.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "touch") return;
    const touch = touches.get(event.pointerId);
    if (!touch) return;
    touch.x = event.clientX; touch.y = event.clientY;
    if (Math.hypot(touch.x - touch.startX, touch.y - touch.startY) > MOVE_PX) clearHold();
    if (pinch && touches.size === 2) {
      // Two fingers are zooming: they don't also drag what they started on.
      event.stopPropagation();
      const [a, b] = [...touches.values()] as [Touch, Touch];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.distance > 0 && distance > 0 && Math.abs(distance - pinch.distance) > 1) {
        const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
        const target = document.elementFromPoint(x, y);
        // The desktop zoom: deltaY of Ctrl + wheel, exp(-deltaY * 0.002) per event.
        target?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -Math.log(distance / pinch.distance) / 0.002, clientX: x, clientY: y }));
        pinch.distance = distance;
      }
    }
  }, { capture: true });

  const end = (event: PointerEvent) => {
    if (event.pointerType !== "touch") return;
    touches.delete(event.pointerId);
    clearHold();
    if (touches.size < 2) pinch = undefined;
    if (swallowClickUntil === Number.POSITIVE_INFINITY && !touches.size) swallowClickUntil = Date.now() + 400;
  };
  document.addEventListener("pointerup", end, { capture: true, passive: true });
  document.addEventListener("pointercancel", end, { capture: true, passive: true });

  document.addEventListener("click", (event) => {
    if (Date.now() < swallowClickUntil) { event.stopPropagation(); event.preventDefault(); }
  }, { capture: true });

  // Don't let a long press select text or open the browser's own menu (inputs keep theirs).
  document.addEventListener("selectstart", (event) => {
    if (holdTimer && !(event.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable]")) event.preventDefault();
  });

  foldLibraryOnSmallScreens();
  sayPressAndHold();
  suggestLandscape();
}

/** On a small tablet the library takes a third of the screen: it starts folded (Shift+B, or its button, opens it). */
function foldLibraryOnSmallScreens() {
  const KEY = "micfx.daw.touchInit";
  try { if (localStorage.getItem(KEY)) return; localStorage.setItem(KEY, "1"); } catch { /* a private window: fold every time */ }
  if (screenWidth() >= 1100) return;
  // The library is built a moment after the page: wait for it (up to 8 s), fold it once.
  let tries = 0;
  const fold = () => {
    const button = document.querySelector<HTMLElement>('[aria-label="Show / hide the library"]');
    const panel = document.querySelector<HTMLElement>(".library-panel");
    const ready = button && panel && panel.querySelector(".library-nav-item") && panel.offsetWidth > 0;
    if (ready && ++settled >= 8) { // still there 1.6 s after the library showed up: the saved view has been applied
      if (button.getAttribute("aria-pressed") === "true") button.click();
      return;
    }
    if (!ready) settled = 0;
    if (++tries < 80) setTimeout(fold, 200);
  };
  let settled = 0;
  setTimeout(fold, 300);
}

/** "Right-click anything for its menu" becomes "Press and hold anything for its menu". */
function sayPressAndHold() {
  const fix = () => {
    for (const node of document.querySelectorAll(".live-hint-line .hint-text, .hint-text")) {
      if (node.textContent?.includes("Right-click")) node.textContent = node.textContent.replace("Right-click anything", "Press and hold anything").replace("Right-click", "Press and hold");
    }
  };
  fix();
  new MutationObserver(fix).observe(document.body, { subtree: true, childList: true, characterData: true });
}

/** A tip when the screen is upright: the DAW has more room sideways. Once. */
function suggestLandscape() {
  const KEY = "micfx.daw.landscapeTip";
  const portrait = matchMedia("(orientation: portrait)");
  try { if (localStorage.getItem(KEY)) return; } catch { /* fine */ }
  if (!portrait.matches || screenWidth() > 1000) return;
  const tip = Object.assign(document.createElement("div"), { className: "web-landscape-tip", role: "status" });
  const text = Object.assign(document.createElement("span"), { textContent: "Turn the tablet sideways for more room." });
  const close = Object.assign(document.createElement("button"), { type: "button", textContent: "OK" });
  close.addEventListener("click", () => { tip.remove(); try { localStorage.setItem(KEY, "1"); } catch { /* fine */ } });
  tip.append(text, close);
  document.body.append(tip);
}
