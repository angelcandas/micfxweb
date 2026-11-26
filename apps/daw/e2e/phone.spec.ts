import { devices, expect, test } from "@playwright/test";

// A phone gets a page that points to MicFX Voice, not the squeezed desktop DAW (mobile plan, phase 0).
const { defaultBrowserType: _browser, ...phone } = devices["iPhone 13"];
test.use(phone);

test("a phone sees the 'bigger screen' page and no engine download", async ({ page }) => {
  const wasm: string[] = [];
  page.on("request", (request) => { if (request.url().endsWith(".wasm")) wasm.push(request.url()); });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "MicFX DAW needs a bigger screen" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Record an idea" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  expect(wasm).toEqual([]);
});

test("?desktop opens the DAW anyway", async ({ page }) => {
  await page.goto("/?desktop");
  await expect(page.locator(".app-title")).toHaveText("MicFX DAW", { timeout: 60_000 });
});
