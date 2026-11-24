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

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("micfx-voice-") && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// The page itself: the network first (a new version shows at once), the cache when offline.
// Everything else: the cache first (the files have content hashes or change with a version).
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("./", { ignoreSearch: true })));
    return;
  }
  event.respondWith(caches.match(request, { ignoreSearch: true }).then((hit) => hit ?? fetch(request)));
});
`;
}
