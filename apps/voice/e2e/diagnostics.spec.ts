import { expect, test } from "@playwright/test";

// Diagnostics (plan section 9, point 30).

test("Settings › Diagnostics shows how the sound runs and copies it for support", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.getByRole("button", { name: "I'm wearing headphones" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.keyboard.press("Control+Comma");
  const section = page.locator(".web-diagnostics");
  await expect(section).toBeVisible();
  const value = (label: string) => section.locator("dt", { hasText: new RegExp(`^${label}$`) }).locator("xpath=following-sibling::dd[1]");
  await expect(value("Sound")).toHaveText("running");
  await expect(value("WebAssembly SIMD")).toHaveText("yes");
  await expect(value("Engine load")).toHaveText(/^\d+ % now, \d+ % at most in the last 10 s$/);
  await expect(value("Buffer")).toHaveText(/^128 samples \(\d\.\d ms\)$/);
  await expect(value("MicFX Voice")).toHaveText(/^\w+ · \d{4}-\d{2}-\d{2}$/);
  await section.getByRole("button", { name: "Copy for support" }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain("WebAssembly SIMD: yes");
  expect(copied).toMatch(/Engine load: \d+ %/);
});
