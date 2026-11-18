import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Clip, defaultArtDirection, exampleClips, exampleRig, Rig } from "@anomaly/core";
import { decodePng, encodePng, sheetCell, type Pixels } from "@anomaly/art";
import { BrowserRenderer } from "../src/art/renderer.ts";

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

      const composed = await renderer.compose({ width: 100, height: 50, background: "#000000", layers: [{ image: cropped, alpha: 0.5 }], grid: 20 });
      expect([composed.readUInt32BE(16), composed.readUInt32BE(20)]).toEqual([100, 50]);

      // World helpers: seamless tiling narrows by the blend; slicing finds the rigs in a 3x1 transparent sheet.
      const tile = await renderer.tileableX(composed, 0.2);
      expect(tile.readUInt32BE(16)).toBe(80);
      const pieces = await renderer.sliceGrid(image.png.length > 0 ? (await renderer.renderRig({
        rig: exampleRig(),
        direction: defaultArtDirection(),
        clips: {},
        frames: [{ clip: null, time: 0 }, { clip: null, time: 0 }, { clip: null, time: 0 }],
        cellWidth: 96,
        cellHeight: 96,
        columns: 3,
        background: null,
      })).png : image.png, 3, 1);
      expect(pieces.map((p) => p.cell)).toEqual([0, 1, 2]);
      expect(pieces[0]!.width).toBeLessThan(96); // trimmed to the visible pixels
    } finally {
      await renderer.close();
    }
  }, 120_000);

  it("paints part textures inside their shape, moving with the bone, and clips detail parts to their part", async () => {
    // A 64x64 texture: red left half, blue right half, on a square panel whose bone turns half a circle.
    const texture: Pixels = { width: 64, height: 64, data: new Uint8Array(64 * 64 * 4) };
    for (let i = 0; i < 64 * 64; i++) texture.data.set(i % 64 < 32 ? [255, 0, 0, 255] : [0, 0, 255, 255], i * 4);
    const file = "00000000000000000000000000000001.png";
    const rig = Rig.parse({
      bones: [
        { id: "root", parent: null, pivot: [50, 90] },
        { id: "body", parent: "root", pivot: [50, 40] },
      ],
      parts: [
        {
          id: "panel",
          bone: "body",
          z: 0,
          shape: { type: "blob", points: [[30, 20], [70, 20], [70, 60], [30, 60]], smooth: 0 },
          fill: "#00ff00",
          ink: 0,
          texture: { file, rect: [30, 20, 40, 40], uv: [0, 0, 64, 64] },
        },
        // A white band wider than the panel, drawn only inside it.
        { id: "band", bone: "body", z: 1, shape: { type: "ellipse", center: [50, 40], rx: 40, ry: 4 }, fill: "#ffffff", ink: 0, clipTo: "panel" },
      ],
    });
    const clips = { turn: Clip.parse({ duration: 1, loop: true, tracks: [{ bone: "body", property: "rotate", keys: [[0, 180], [1, 180]] }] }) };
    const renderer = new BrowserRenderer(exportDir);
    try {
      const image = await renderer.renderRig({
        rig,
        direction: { ...defaultArtDirection(), boil: 0 },
        clips,
        frames: [
          { clip: null, time: 0 },
          { clip: "turn", time: 0.5 },
        ],
        cellWidth: 100,
        cellHeight: 100,
        columns: 2,
        background: "#000000",
        fit: false,
        images: { [file]: encodePng(texture).toString("base64") },
      });
      expect(image.warnings).toEqual([]);
      const px = decodePng(image.png);
      const at = (x: number, y: number) => Array.from(px.data.subarray((y * px.width + x) * 4, (y * px.width + x) * 4 + 3));
      // Rest: red on the left, blue on the right (never the green fill); the band only inside the panel.
      expect(at(36, 28)).toEqual([255, 0, 0]);
      expect(at(64, 52)).toEqual([0, 0, 255]);
      expect(at(50, 40)).toEqual([255, 255, 255]);
      expect(at(20, 40)).toEqual([0, 0, 0]);
      expect(at(80, 40)).toEqual([0, 0, 0]);
      // Turned half a circle about its pivot: the texture turns with it.
      expect(at(100 + 36, 28)).toEqual([0, 0, 255]);
      expect(at(100 + 64, 52)).toEqual([255, 0, 0]);

      // Without the image the part shows its flat fill (and says so).
      const missing = await renderer.renderRig({ rig, direction: defaultArtDirection(), clips: {}, frames: [{ clip: null, time: 0 }], cellWidth: 100, cellHeight: 100, columns: 1, background: "#000000", fit: false });
      expect(missing.warnings.join(" ")).toMatch(/part texture .* was not sent/);
      const flat = decodePng(missing.png);
      expect(Array.from(flat.data.subarray((28 * 100 + 36) * 4, (28 * 100 + 36) * 4 + 3))).toEqual([0, 255, 0]);
    } finally {
      await renderer.close();
    }
  }, 120_000);
});
