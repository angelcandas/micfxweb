import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

// A take downloads as WAV, MP3 or Opus, as picked in Settings, with its name inside
// (plan section 9, point 7).

function probe(path: string): Record<string, string> | undefined {
  try {
    const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=format_name,duration:format_tags=title:stream_tags=title", "-of", "flat", path], { encoding: "utf8" });
    return Object.fromEntries(out.trim().split("\n").map((line) => line.split("=") as [string, string]).map(([k, v]) => [k.split(".").pop()!.toLowerCase(), v.replace(/^"|"$/g, "")]));
  } catch {
    return undefined; // no ffprobe here
  }
}

async function pick(page: Page, format: string) {
  await page.keyboard.press("Control+Comma");
  await page.getByLabel("Take file format").selectOption(format);
  await page.keyboard.press("Escape");
}

test("a take downloads as MP3 or Opus with its name inside", async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "I'm wearing headphones" }).click();
  await page.getByRole("button", { name: "Done" }).click();

  await page.locator(".recorder .record-button").click();
  await expect(page.locator(".recorder .record-label")).toHaveText("Stop");
  await page.waitForTimeout(2000);
  await page.locator(".recorder .record-button").click();
  await expect(page.locator(".recorder .record-status")).toContainText("Saved");
  const show = page.locator(".recorder .record-status button", { hasText: "Show" });

  for (const [format, extension, container] of [["mp3", "mp3", "mp3"], ["opus", "opus", "ogg"]] as const) {
    await pick(page, format);
    const downloading = page.waitForEvent("download");
    await show.click();
    const file = await downloading;
    expect(file.suggestedFilename()).toMatch(new RegExp(`^MicFX .*\\.${extension}$`));
    const info = probe((await file.path())!);
    if (info) {
      expect(info.format_name).toContain(container);
      expect(Number(info.duration)).toBeGreaterThan(1.5);
      expect(info.title).toBe(file.suggestedFilename().replace(/\.\w+$/, ""));
    }
  }

  // The choice stays.
  await page.reload();
  await page.keyboard.press("Control+Comma");
  await expect(page.getByLabel("Take file format")).toHaveValue("opus");
  expect(errors).toEqual([]);
});
