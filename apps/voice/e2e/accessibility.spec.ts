import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// The accessibility pass (plan section 9, point 14): no axe violations in the main views,
// knobs work from the keyboard, and Settings › Look has high contrast and reduced motion.

async function violations(page: Page) {
  // The hover tooltip (role="tooltip", shown under the mouse) floats over the page and belongs
  // to the control it describes, not to a landmark; it shows only if the mouse rests on a control.
  const result = await new AxeBuilder({ page }).exclude(".tip").analyze();
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`);
}

async function begin(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "I'm wearing headphones" }).click();
  await page.getByRole("button", { name: "Done" }).click();
}

test("the views pass axe", async ({ page }) => {
  test.setTimeout(60_000);
  await begin(page);
  expect(await violations(page)).toEqual([]);

  const toggle = (name: string) => page.getByRole("button", { name, exact: true }).first().click();
  for (const view of ["Looper", "Practice"]) {
    await toggle(view);
    await page.waitForTimeout(300);
    expect(await violations(page), view).toEqual([]);
    await toggle(view);
  }
  await page.keyboard.press("Control+Comma");
  await expect(page.locator(".settings-window")).toBeVisible();
  expect(await violations(page), "Settings").toEqual([]);
});

test("a knob turns from the keyboard", async ({ page }) => {
  await begin(page);
  const knob = page.getByRole("slider", { name: /cutoff/i }).first();
  await knob.focus();
  const before = await knob.getAttribute("aria-valuenow");
  await page.keyboard.press("ArrowUp");
  await expect(knob).not.toHaveAttribute("aria-valuenow", before ?? "");
});

test("high contrast and reduced motion follow the system, and Settings can change them", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await begin(page);
  const body = page.locator("body");
  await expect(body).toHaveClass(/web-reduce-motion/);
  await expect(body).not.toHaveClass(/web-contrast/);

  await page.keyboard.press("Control+Comma");
  await page.getByLabel("High contrast").check();
  await page.getByLabel("Reduce motion").uncheck();
  await expect(body).toHaveClass(/web-contrast/);
  await expect(body).not.toHaveClass(/web-reduce-motion/);

  await page.reload();
  await expect(body).toHaveClass(/web-contrast/);
  await expect(body).not.toHaveClass(/web-reduce-motion/);
});
