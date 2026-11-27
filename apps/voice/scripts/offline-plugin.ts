// Writes sw.js at build time: a service worker that keeps every file of the build (the app,
// the engine, the desktop UI) so MicFX Voice opens and plays without a network once loaded.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Plugin } from "vite";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

export function offline(publicDir: string): Plugin {
  return {
    name: "micfx-offline",
    apply: "build",
    generateBundle(_options, bundle) {
      const skip = /(^|\/)(_headers|sw\.js)$|\.map$|^simple\.html$/;
      const files = [
        ...Object.keys(bundle),
        ...walk(publicDir).map((path) => relative(publicDir, path).split("\\").join("/")),
      ].filter((file) => !skip.test(file));
      const hash = createHash("sha256");
      for (const file of files.sort()) {
        const item = bundle[file];
        hash.update(file);
        if (item) hash.update(item.type === "chunk" ? item.code : item.source);
        else hash.update(readFileSync(join(publicDir, file)));
      }
      const version = hash.digest("hex").slice(0, 12);
      this.emitFile({ type: "asset", fileName: "sw.js", source: serviceWorker(version, ["./", ...files]) });
    },
  };
}

function serviceWorker(version: string, files: string[]): string {
  return `// MicFX Voice's offline cache (generated at build time).
const CACHE = "micfx-voice-${version}";
const FILES = ${JSON.stringify(files)};

// A new version is cached in the background and waits: it starts when MicFX is next opened
// (every MicFX tab closed), or at once when the page asks ("Restart now"). So a song never
// switches versions halfway through.
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "start-new-version") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("micfx-voice-") && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Everything, the page included, comes from this version's cache (so the page and its files
// always match), and from the network for anything the cache doesn't hold.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    const path = new URL(request.url).pathname;
    const scope = new URL(self.registration.scope).pathname;
    if (path === scope || path === scope + "index.html") event.respondWith(caches.open(CACHE).then((cache) => cache.match("./")).then((hit) => hit ?? fetch(request)));
    return;
  }
  event.respondWith(caches.open(CACHE).then((cache) => cache.match(request, { ignoreSearch: true })).then((hit) => hit ?? fetch(request)));
});
`;
}
