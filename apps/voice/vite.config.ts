import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { offline } from "./scripts/offline-plugin";

// The build's name for Diagnostics: the commit and the day it was built.
function buildName(): string {
  let commit = process.env.GITHUB_SHA?.slice(0, 7) ?? "";
  try {
    commit ||= execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    // not a checkout
  }
  return `${commit || "dev"} · ${new Date().toISOString().slice(0, 10)}`;
}

// Relative base so the build works from any path. Two pages: the app (the desktop UI on the
// web bridge) and simple.html (a small page around the engine, for checks).
export default defineConfig({
  base: "./",
  define: { __MICFX_BUILD__: JSON.stringify(buildName()) },
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
