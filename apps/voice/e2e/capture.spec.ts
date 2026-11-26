import { devices, expect, test, type Page } from "@playwright/test";

// Capture (mobile plan, phase 1): open, tap, record; the take is safe as it's recorded.
const { defaultBrowserType: _browser, ...phone } = devices["iPhone 13"];
test.use(phone);

const record = (page: Page) => page.getByRole("button", { name: /^(Record|Stop)$/ }).first();

async function ready(page: Page) {
  await page.goto("/");
  await expect(page).toHaveURL(/capture\.html/); // a phone opens on Capture
  await expect(record(page)).toBeVisible();
}

test("a phone opens on Capture, and one tap records an idea that is kept", async ({ page, context }) => {
  await context.grantPermissions(["microphone"]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  const box = await record(page).boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(100);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height); // on the first screen

  await record(page).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mark this moment" })).toBeVisible();
  await page.waitForTimeout(3000);
  expect(await page.getByRole("timer").textContent()).not.toBe("0:00.0");
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: /Ideas/ }).click();
  const card = page.locator("article.idea");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Idea ·");
  // The audio is a real WAV of about three seconds.
  const seconds = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("ideas");
    for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemFileHandle]> }).entries()) {
      if (!name.endsWith(".wav")) continue;
      const file = await handle.getFile();
      return (file.size - 44) / 2 / new DataView(await file.arrayBuffer()).getUint32(24, true);
    }
    return 0;
  });
  expect(seconds).toBeGreaterThan(2.5);
  expect(seconds).toBeLessThan(6);

  // Still there after a reload; rename and star it.
  await page.reload();
  await page.getByRole("tab", { name: /Ideas/ }).click();
  await expect(page.locator("article.idea")).toHaveCount(1);
  await page.getByRole("button", { name: /^More for/ }).click();
  await page.getByRole("button", { name: "Star", exact: true }).click();
  await expect(page.locator("article.idea")).toContainText("★");
  expect(errors).toEqual([]);
});

test("a take cut short by a crash is recovered", async ({ browser }) => {
  const context = await browser.newContext({ ...phone });
  await context.grantPermissions(["microphone"]);
  const page = await context.newPage();
  await ready(page);
  await record(page).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.waitForTimeout(2500);
  // The tab goes away without Stop (a crash, a call, a dead battery).
  const again = await context.newPage();
  await page.close({ runBeforeUnload: false });
  await again.goto("/capture.html#ideas");
  const card = again.locator("article.idea");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Recovered");
  await context.close();
});

test("the Live screen is still there, behind ?live", async ({ page }) => {
  await page.goto("/?live=1");
  await expect(page.locator(".recorder .record-button")).toBeVisible();
  await expect(page.getByRole("link", { name: "Capture" })).toBeVisible();
});

test("the desktop keeps the Live screen", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page).not.toHaveURL(/capture/);
  await context.close();
});
