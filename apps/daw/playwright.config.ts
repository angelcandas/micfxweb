import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

// A sung "ah" as the fake mic, for recording.
const voice = fileURLToPath(new URL("./e2e/voice.wav", import.meta.url));

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:4175",
    trace: "off",
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${voice}`, "--autoplay-policy=no-user-gesture-required"],
    },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "pnpm exec vite preview --port 4175 --strictPort",
    url: "http://localhost:4175",
    reuseExistingServer: !process.env.CI,
  },
});
