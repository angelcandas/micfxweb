import { defineConfig } from "vitest/config";

// Unit tests (test/); the browser tests in e2e/ run with Playwright.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
