import { devices, expect, test, type Page } from "@playwright/test";

// Phones and tablets (plan section 9, point 1): one column without sideways scrolling, the
// effect list as a sheet, and the views (Looper, Practice) reachable on narrow screens.

const { defaultBrowserType: _phoneBrowser, ...phone } = devices["iPhone 13"];
test.use(phone);

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

test("the Live view fits a phone, and effects come from a sheet", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/?live=1");
  await page.locator(".recorder .record-button").waitFor();
  // No desktop welcome card on a phone.
  await expect(page.locator(".setup-backdrop:not([hidden])")).toHaveCount(0);
  expect(await sideways(page)).toBeLessThanOrEqual(0);

  const sheet = page.locator("nav.sidebar");
  await expect(sheet).toBeHidden();
  await page.getByRole("button", { name: "Effects", exact: true }).click();
  await expect(sheet).toBeVisible();
  const robot = sheet.locator('.effect-item[data-learn="param:robotOn"]');
  await robot.click();
  await expect(robot).toHaveAttribute("aria-pressed", "true");
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toBeHidden();
  await expect(page.locator('.chain-grid section[data-insert="robot"]')).toBeVisible();

  for (const chip of [".chip.loop-toggle", ".chip.practice-toggle"]) {
    await page.locator(chip).first().click();
    await page.waitForTimeout(200);
    expect(await sideways(page), chip).toBeLessThanOrEqual(0);
    await page.locator(chip).first().click();
  }
  expect(errors).toEqual([]);
});

test("a tablet keeps the Looper and Practice buttons", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/?live=1");
  await page.locator(".recorder .record-button").waitFor();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".chip.practice-toggle")).toBeVisible();
  await expect(page.locator(".chip.loop-toggle").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Effects", exact: true })).toBeHidden();
  expect(await sideways(page)).toBeLessThanOrEqual(0);
});

test("phone: touch-sized controls, a record bar that stays in view, no desktop-only controls", async ({ page }) => {
  await page.goto("/?live=1");
  const record = page.locator(".recorder .record-button");
  await record.waitFor();
  await page.waitForTimeout(500);
  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("button, select")]
      .filter((el) => el.offsetParent && !el.closest("nav.sidebar"))
      .map((el) => [el.className, Math.round(el.getBoundingClientRect().height)] as const)
      .filter(([, h]) => h < 44),
  );
  expect(small).toEqual([]);
  // The record bar is on screen without scrolling, and still is after scrolling down.
  const inView = async () => record.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
  expect(await inView()).toBe(true);
  await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
  expect(await inView()).toBe(true);
  for (const hidden of [".web-video-button", ".computer-audio", ".midi-button"]) await expect(page.locator(hidden).first()).toBeHidden();
  // "More" opens the rest of the recorder.
  await expect(page.locator(".recorder .add-track")).toBeHidden();
  await page.getByRole("button", { name: "More" }).click();
  await expect(page.locator(".recorder .add-track")).toBeVisible();
  expect(await sideways(page)).toBeLessThanOrEqual(0);
});
