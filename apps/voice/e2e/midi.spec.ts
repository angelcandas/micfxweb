import { expect, test } from "@playwright/test";

// MIDI learn over Web MIDI, with a fake MIDI keyboard/pedal standing in for a device.

test("a pedal learned for an effect switches it", async ({ page }) => {
  await page.addInitScript(() => {
    const input: { onmidimessage: ((event: { data: Uint8Array }) => void) | null } = { onmidimessage: null };
    (window as any).__sendMidi = (...bytes: number[]) => input.onmidimessage?.({ data: new Uint8Array(bytes) });
    (navigator as any).requestMIDIAccess = async () => ({ inputs: new Map([["pedal", input]]), onstatechange: null });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Done" }).click();

  const robot = page.locator('.effect-item[data-learn="param:robotOn"]');
  await page.locator(".midi-button").click();
  await robot.click(); // picks it, rather than switching it
  await expect(page.locator(".learn-banner")).toContainText("Move a pedal");
  await page.evaluate(() => (window as any).__sendMidi(0xb0, 64, 127));
  await expect(page.locator(".learn-banner")).toContainText("CC 64 · ch 1 now controls");
  await expect(robot).toHaveAttribute("aria-pressed", "false");
  await page.locator(".learn-done").click();

  await page.evaluate(() => (window as any).__sendMidi(0xb0, 64, 0));
  await page.evaluate(() => (window as any).__sendMidi(0xb0, 64, 127));
  await expect(robot).toHaveAttribute("aria-pressed", "true");

  // The mapping is the app's: still there after a reload.
  await page.reload();
  await page.locator(".midi-button").click();
  await expect(page.locator(".learn-banner")).toContainText("CC 64");
});
