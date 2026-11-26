import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// A sung "ah" as the fake mic (Chromium's default fake mic is silent in headless runs).
const voice = fileURLToPath(new URL("./e2e/voice.wav", import.meta.url));

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  // One at a time on CI: the whole-song split (Practice) needs the runner's cores, and the Capture tests
  // (analysis, polish, key finding) running beside it pushed it past its time.
  workers: process.env.CI ? 1 : undefined,
  use: {
    baseURL: "http://localhost:4173",
    trace: "off",
    launchOptions: {
      // A fake mic and no permission prompt.
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${voice}`, "--autoplay-policy=no-user-gesture-required"],
    },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "pnpm exec vite preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
  },
});
