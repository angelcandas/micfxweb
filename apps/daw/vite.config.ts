import { resolve } from "node:path";
import { defineConfig, type Connect } from "vite";

// The DAW engine uses threads (SharedArrayBuffer), so its pages must be cross-origin isolated:
// these headers in dev and preview, and public/_headers on Cloudflare Pages. handoff.html is
// the exception: it talks to MicFX Voice's window, which isolation would cut off.
const isolation: Connect.NextHandleFunction = (request, response, next) => {
  if (!/\/handoff(\.html)?$/.test(request.url?.split("?")[0] ?? "")) {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  }
  next();
};

export default defineConfig({
  base: "./",
  plugins: [{
    name: "micfx-isolation",
    configureServer: (server) => { server.middlewares.use(isolation); },
    configurePreviewServer: (server) => { server.middlewares.use(isolation); },
  }],
  worker: { format: "es" },
  build: {
    target: "es2022",
    rollupOptions: { input: { main: resolve(import.meta.dirname, "index.html"), handoff: resolve(import.meta.dirname, "handoff.html") } },
  },
});
