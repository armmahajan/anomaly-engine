import { expect, test } from "@playwright/test";
import { exampleRig } from "@anomaly/core";
import { decodePng, encodePng } from "@anomaly/art";
import { openStudio, resetProject } from "./helpers.ts";

// The bone editor's pose test draws a layered rig's mesh part: its texture region over its rest
// rect, clipped to the mesh outline (rest pose only; the runtime bends meshes, see game/test/rigMesh.test.ts).

test.afterEach(({ page }) => resetProject(page));

const FILE = "fedcba9876543210fedcba9876543210.png";
const MAGENTA = [255, 0, 255];
const GREEN = [0, 255, 0];

/** 64x64: magenta in the middle 32x32 (the part's uv region), green around it. */
function texture(): Buffer {
  const data = new Uint8Array(64 * 64 * 4);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const inside = x >= 16 && x < 48 && y >= 16 && y < 48;
      data.set([...(inside ? MAGENTA : GREEN), 255], (y * 64 + x) * 4);
    }
  }
  return encodePng({ width: 64, height: 64, data });
}

test("the bone editor's pose test shows a mesh part's texture inside its outline", async ({ page }) => {
  const png = texture();
  await page.route(`**/api/files/${FILE}`, (route) => route.fulfill({ status: 200, body: png, contentType: "image/png" }));
  await openStudio(page);
  // The beetle with a layered part over its shell: a diamond inside the rect [-22, -34, 36, 26].
  const [x0, y0, w, h] = [-22, -34, 36, 26];
  const points: [number, number][] = [[-4, -34], [14, -21], [-4, -8], [-22, -21]];
  const inner: [number, number][] = [[-4, -21]];
  const uv = [...points, ...inner].map(([x, y]) => [16 + ((x - x0) * 32) / w, 16 + ((y - y0) * 32) / h]);
  const base = exampleRig();
  const rig = {
    ...base,
    mode: "layered",
    parts: [
      ...base.parts,
      {
        id: "shell_layer",
        bone: "body",
        z: 10,
        fill: "#888888",
        texture: { file: FILE, rect: [x0, y0, w, h], uv: [16, 16, 32, 32] },
        shape: { type: "mesh", points, inner, triangles: [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4], uv },
      },
    ],
  };
  const result = await page.evaluate(
    (calls) => window.studio!.applyBatch(calls),
    [
      { name: "createAsset", input: { asset: { id: "beetle", name: "Beetle", kind: "character", brief: "a horned beetle" }, assignTo: "charger" } },
      { name: "setRig", input: { assetId: "beetle", rig } },
    ],
  );
  expect(result.ok, JSON.stringify(result)).toBe(true);

  await page.getByTestId("character-charger").click();
  await page.getByRole("tab", { name: "Characters" }).click();
  await page.getByRole("button", { name: /② Rig/ }).click();
  await page.getByLabel("Edit bones").check();
  await page.getByTestId("bone-editor").getByLabel("pose test").check();
  const overlay = page.getByTestId("bone-overlay");
  const mesh = overlay.getByTestId("pose-preview").getByTestId("pose-mesh");
  await expect(mesh).toHaveCount(1);

  // The image spans the whole texture: its middle half is the part's rect.
  const box = (await mesh.boundingBox())!;
  expect(box.width).toBeGreaterThan(40);
  const shot = decodePng(await page.screenshot());
  const scale = shot.width / page.viewportSize()!.width;
  const at = (fx: number, fy: number) => {
    const i = (Math.round((box.y + box.height * fy) * scale) * shot.width + Math.round((box.x + box.width * fx) * scale)) * 4;
    return [shot.data[i]!, shot.data[i + 1]!, shot.data[i + 2]!];
  };
  const near = (got: number[], want: number[]) => got.every((v, i) => Math.abs(v - want[i]!) <= 40);
  // The middle of the rect, inside the diamond: the texture's uv region.
  await expect.poll(() => near(at(0.5, 0.5), MAGENTA), { message: `centre ${at(0.5, 0.5)}` }).toBe(true);
  expect(near(at(0.45, 0.4), MAGENTA)).toBe(true);
  // A corner of the rect (outside the diamond) and outside the rect: clipped away.
  for (const [fx, fy] of [[0.28, 0.28], [0.72, 0.72], [0.1, 0.5], [0.5, 0.9]] as const) {
    const got = at(fx, fy);
    expect(near(got, MAGENTA) || near(got, GREEN), `${fx},${fy}: ${got}`).toBe(false);
  }
});
