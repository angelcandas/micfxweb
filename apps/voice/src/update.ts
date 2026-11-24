// The offline cache and the "update ready" notice (plan section 9, point 11). A new version
// downloads in the background (sw.js caches it and waits); the page says so, and it starts
// the next time MicFX opens, or now with "Restart now" when nothing is playing.

const CHECK_EVERY_MS = 60 * 60 * 1000;

export function registerOffline(busy: () => boolean) {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker
    .register("sw.js")
    .then((registration) => {
      // A version that finished downloading earlier, still waiting.
      if (registration.waiting && navigator.serviceWorker.controller) showNotice(registration.waiting, busy);
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          // The first install has no controller yet: that's not an update.
          if (worker.state === "installed" && navigator.serviceWorker.controller) showNotice(worker, busy);
        });
      });
      setInterval(() => void registration.update().catch(() => {}), CHECK_EVERY_MS);
    })
    .catch((error) => console.warn("MicFX: offline mode isn't available", error));
}

function showNotice(worker: ServiceWorker, busy: () => boolean) {
  if (document.querySelector(".web-update")) return;
  const notice = document.createElement("div");
  notice.className = "web-update";
  notice.setAttribute("role", "status");
  const text = document.createElement("span");
  text.textContent = "A new version of MicFX is ready. It starts next time you open MicFX.";
  const restart = Object.assign(document.createElement("button"), { type: "button", className: "tool is-accent", textContent: "Restart now" });
  const later = Object.assign(document.createElement("button"), { type: "button", className: "tool", textContent: "Later" });
  restart.addEventListener("click", () => {
    if (busy() && !window.confirm("Something is playing or recording. Restart MicFX now anyway?")) return;
    navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
    worker.postMessage({ type: "start-new-version" });
    restart.disabled = true;
  });
  later.addEventListener("click", () => notice.remove());
  notice.append(text, restart, later);
  document.body.append(notice);
}
