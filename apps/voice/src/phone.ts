// Phones and tablets (plan section 9, point 1): on a narrow screen the Live view is one
// column (levels, then the effect cards, one to a row, with bigger knobs), and the effect
// list is a sheet that slides up from an "Effects" button. The styles are in web.css
// ("Phones"); this adds the sheet's button and closes it.
//
// A phone's sound goes through the system's audio path, so its delay is shown as measured
// (Settings › Audio › Latency) and suits recording and practice more than live monitoring.

export const PHONE_QUERY = "(max-width: 760px)";

export function addPhoneLayout() {
  const chain = document.querySelector("main.chain");
  const sidebar = document.querySelector<HTMLElement>("nav.sidebar");
  if (!chain || !sidebar || document.querySelector(".web-fx-sheet-button")) return;

  const open = Object.assign(document.createElement("button"), { type: "button", className: "tool web-fx-sheet-button", textContent: "Effects" });
  open.setAttribute("aria-expanded", "false");
  open.title = "Add, remove and find effects";
  const scenes = chain.querySelector(".scene-bar");
  if (scenes) scenes.after(open);
  else chain.prepend(open);

  const close = Object.assign(document.createElement("button"), { type: "button", className: "tool web-fx-sheet-close", textContent: "Done" });
  sidebar.querySelector(".sidebar-header")?.append(close);

  const backdrop = Object.assign(document.createElement("div"), { className: "web-fx-sheet-backdrop" });
  sidebar.before(backdrop);

  const show = (on: boolean) => {
    document.body.classList.toggle("web-fx-sheet-open", on);
    open.setAttribute("aria-expanded", String(on));
    if (on) sidebar.querySelector<HTMLElement>(".sidebar-search, button")?.focus({ preventScroll: true });
    else if (matchMedia(PHONE_QUERY).matches) open.focus({ preventScroll: true });
  };
  open.addEventListener("click", () => show(true));
  close.addEventListener("click", () => show(false));
  backdrop.addEventListener("click", () => show(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.classList.contains("web-fx-sheet-open")) show(false);
  });
  matchMedia(PHONE_QUERY).addEventListener("change", (event) => {
    if (!event.matches) show(false);
  });
}

/** Phones: the recorder is a bar at the bottom (Record, time); "More" opens the rest of it. */
export function addTransportMore() {
  const transport = document.querySelector<HTMLElement>(".recorder .transport");
  if (!transport || transport.querySelector(".web-transport-more")) return;
  const more = Object.assign(document.createElement("button"), { type: "button", className: "tool web-transport-more", textContent: "More" });
  more.setAttribute("aria-expanded", "false");
  more.title = "Backing track, click, dry mic and more";
  more.addEventListener("click", () => {
    const open = document.body.classList.toggle("web-transport-open");
    more.setAttribute("aria-expanded", String(open));
    more.textContent = open ? "Less" : "More";
  });
  transport.append(more);
}

/** Phones: a way back to Capture from the Live screen. */
export function addCaptureLink() {
  const chips = document.querySelector(".topbar .chips");
  if (!chips || chips.querySelector(".web-capture-link")) return;
  const link = Object.assign(document.createElement("a"), { className: "chip web-capture-link", href: "capture.html", textContent: "Capture", title: "Record an idea in one tap" });
  chips.prepend(link);
}
