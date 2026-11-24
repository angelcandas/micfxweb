import { expect, test } from "@playwright/test";

// Sound check on the web: the fake mic sings, the desktop's planner (analysis.wasm, in a
// worker) sets the chain, and Before / After and Revert work.

test("a sound check listens to the mic and sets the chain for it", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await page.getByRole("button", { name: "Done" }).click();
  const hpf = page.locator('.effect-item[data-learn="param:hpfOn"]');
  const hpfBefore = await hpf.getAttribute("aria-pressed");

  await page.locator(".sound-check").click();
  const panel = page.locator(".soundcheck");
  await expect(panel.locator(".soundcheck-field select").first()).toContainText("Speech / podcast");
  await panel.locator(".soundcheck-field select").nth(1).selectOption("10");
  await panel.locator(".soundcheck-start").click();
  await expect(panel.locator(".soundcheck-info")).toContainText("Heard", { timeout: 10_000 });

  // The voice: the meter moves, then Done once there's enough of it.
  await expect(panel.getByRole("button", { name: "Done" })).toBeEnabled({ timeout: 15_000 });
  await panel.getByRole("button", { name: "Done" }).click();
  await expect(panel.locator(".soundcheck-changes li").first()).toBeVisible({ timeout: 20_000 });
  const changes = await panel.locator(".soundcheck-changes li").allTextContents();
  expect(changes.length).toBeGreaterThan(0);

  // Revert puts the sound from before back.
  await panel.getByRole("button", { name: /Revert|Go back/ }).click();
  await expect(hpf).toHaveAttribute("aria-pressed", hpfBefore ?? "false");
});
