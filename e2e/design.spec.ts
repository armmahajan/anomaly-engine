import { expect, test } from "@playwright/test";
import { collectConsoleErrors, openStudio, resetProject } from "./helpers.ts";

test.afterEach(({ page }) => resetProject(page));

test("Rooms: put a room in a progression region; the world map colors it", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openStudio(page);
  for (const [id, name] of [["caves", "The Caves"], ["spire", "The Spire"]]) {
    const result = await page.evaluate((region) => window.studio!.applyOperation("createRegion", { region }), { id, name, rooms: 2, status: "canon" });
    expect(result.ok).toBe(true);
  }
  await page.getByRole("tab", { name: "Rooms" }).click();
  const roomId = await page.evaluate(() => window.studio!.getProject().world.rooms[0]!.id);
  await page.getByTestId(`room-${roomId}`).click();
  const mapRoom = page.getByTestId(`map-room-${roomId}`);
  const fill = () => mapRoom.locator("rect").evaluate((r) => getComputedStyle(r).fill);
  const plain = await fill();
  await expect(mapRoom).toHaveAttribute("data-region", "");

  const picker = page.getByLabel("room region");
  await picker.selectOption({ label: "The Spire" });
  await expect.poll(() => page.evaluate((id) => window.studio!.getProject().world.rooms.find((r) => r.id === id)?.regionId, roomId)).toBe("spire");
  await expect(mapRoom).toHaveAttribute("data-region", "spire");
  await expect(page.getByTestId("region-picker")).toContainText("1 of 2 planned rooms");
  const spire = await fill();
  expect(spire).not.toBe(plain);

  // Another region, another color; none takes the room out again.
  await picker.selectOption({ label: "The Caves" });
  await expect(mapRoom).toHaveAttribute("data-region", "caves");
  expect(await fill()).not.toBe(spire);
  await picker.selectOption({ label: "— none —" });
  await expect.poll(() => page.evaluate((id) => window.studio!.getProject().world.rooms.find((r) => r.id === id)?.regionId ?? null, roomId)).toBeNull();
  await expect.poll(fill).toBe(plain);
  expect(consoleErrors).toEqual([]);
});
