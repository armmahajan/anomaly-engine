import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultArtDirection, exampleClips, exampleRig } from "@anomaly/core";
import { BrowserRenderer, sheetCell } from "../src/art/renderer.ts";

/** The real GDScript rig renderer: headless data checks, and pixels via the web export. */

const GODOT = process.env.GODOT ?? "godot";
const gameDir = fileURLToPath(new URL("../../../game", import.meta.url));
const exportDir = fileURLToPath(new URL("../../../apps/studio/public/game", import.meta.url));
const hasGodot = spawnSync(GODOT, ["--version"], { stdio: "ignore" }).status === 0;
const hasExport = existsSync(join(exportDir, "index.html"));

describe.skipIf(!hasGodot)("GDScript rig renderer (headless Godot)", () => {
  it("builds every part of the example rig and every clip moves", () => {
    const file = join(mkdtempSync(join(tmpdir(), "rig-")), "rig.json");
    writeFileSync(file, JSON.stringify({ rig: exampleRig(), clips: exampleClips(), direction: defaultArtDirection() }));
    const out = execFileSync(GODOT, ["--headless", "--path", gameDir, "--script", "res://tests/rig_test.gd", "--", file], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    expect(out).toContain("parts built: 9 of 9");
    expect(out).toContain("OK");
  }, 90_000);
});

describe.skipIf(!hasExport || process.env.SKIP_BROWSER_TESTS === "1")("BrowserRenderer (headless Chromium + web export)", () => {
  it("renders frames of a rig into one PNG sheet and crops images", async () => {
    const renderer = new BrowserRenderer(exportDir);
    try {
      const image = await renderer.renderRig({
        rig: exampleRig(),
        direction: defaultArtDirection(),
        clips: exampleClips(),
        frames: [
          { clip: null, time: 0 },
          { clip: "walk", time: 0.2 },
          { clip: "windup", time: 0.5 },
        ],
        cellWidth: 128,
        cellHeight: 96,
        columns: 3,
        background: "#ffffff",
      });
      expect(image.png.subarray(1, 4).toString()).toBe("PNG");
      expect([image.width, image.height]).toEqual([384, 96]);
      expect(image.warnings).toEqual([]);

      const cropped = await renderer.crop(image.png, sheetCell(1), 64);
      expect(cropped.readUInt32BE(16)).toBeLessThanOrEqual(64); // PNG IHDR width
    } finally {
      await renderer.close();
    }
  }, 120_000);
});
