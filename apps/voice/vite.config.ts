import { resolve } from "node:path";
import { defineConfig } from "vite";
import { offline } from "./scripts/offline-plugin";

// Relative base so the build works from any path. Two pages: the app (the desktop UI on the
// web bridge) and simple.html (a small page around the engine, for checks).
export default defineConfig({
  base: "./",
  plugins: [offline(resolve(import.meta.dirname, "public"))],
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        simple: resolve(import.meta.dirname, "simple.html"),
      },
    },
  },
});
