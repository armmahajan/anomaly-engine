import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { BrowserRenderer } from "../src/art/renderer.ts";

/** Slicing piece sheets in the real (headless Chromium) renderer. */

const exportDir = fileURLToPath(new URL("../../../apps/studio/public/game", import.meta.url));
const hasExport = existsSync(join(exportDir, "index.html"));

type Rect = [x0: number, y0: number, x1: number, y1: number];

/** An RGBA PNG: transparent (or opaque grey) with solid rectangles. */
function sheet(size: number, rects: Rect[], opaque = false): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const on = rects.some(([x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1);
      if (on || opaque) row.set(on ? [60, 90, 110, 255] : [200, 190, 150, 255], 1 + x * 4);
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe.skipIf(!hasExport)("sheet slicing", () => {
  const renderer = new BrowserRenderer(exportDir);
  afterAll(() => renderer.close());

  it("keeps a piece whole when it runs past its cell, and leaves out its neighbours' overhangs", async () => {
    const pieces = await renderer.sliceGrid(
      sheet(300, [
        [5, 230, 150, 251], // a long beam in cell 6, running into cell 7
        [20, 120, 40, 216], // icicles in cell 3, hanging into cell 6
        [140, 110, 160, 190], // a pillar in cell 4
      ]),
      3,
      3,
    );
    const byCell = Object.fromEntries(pieces.map((p) => [p.cell, p]));
    expect(Object.keys(byCell).sort()).toEqual(["3", "4", "6"]);
    expect(byCell[6]).toMatchObject({ width: 145, height: 21 }); // whole, and without the icicle tips above it
    expect(byCell[3]).toMatchObject({ width: 20, height: 96 });
    expect(byCell[4]).toMatchObject({ width: 20, height: 80 });
  }, 60_000);

  it("cuts an opaque sheet along the grid", async () => {
    const pieces = await renderer.sliceGrid(sheet(300, [], true), 3, 3);
    expect(pieces.map((p) => p.cell)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(pieces[0]).toMatchObject({ width: 100, height: 100 });
  }, 60_000);
});
