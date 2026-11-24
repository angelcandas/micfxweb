import { expect, test } from "@playwright/test";

// Spanish (plan section 9, point 13): a Spanish browser gets the app in Spanish, the app
// keeps working, and Settings › Look › Language switches it back to English.

test.use({ locale: "es-ES" });

test("a Spanish browser gets MicFX in Spanish, and Settings switches it to English", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await page.getByRole("button", { name: "Llevo auriculares" }).click();
  await page.getByRole("button", { name: "Hecho" }).click();

  // Effects still turn on, and what the app draws afterwards is Spanish too.
  const robot = page.locator('nav.sidebar .effect-item[data-learn="param:robotOn"]');
  await robot.click();
  await expect(robot).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('.chain-grid section[data-insert="robot"]')).toBeVisible();
  await expect(page.getByText("Grabar", { exact: true }).first()).toBeVisible();

  // Back to English from Settings › Look.
  await page.keyboard.press("Control+Comma");
  await expect(page.locator(".settings-window")).toBeVisible();
  await expect(page.locator(".web-language-row .setup-row-label")).toHaveText("Idioma");
  await page.locator("select.web-language").selectOption("en");
  await page.waitForLoadState("load");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("navigation", { name: "Effects" })).toBeVisible();
  expect(errors).toEqual([]);
});
