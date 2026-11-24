import { defineConfig } from "vite";

// The DAW engine uses threads (SharedArrayBuffer), so every page must be cross-origin
// isolated: these headers in dev and preview, and public/_headers on Cloudflare Pages.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  base: "./",
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: "es" },
  build: { target: "es2022" },
});
