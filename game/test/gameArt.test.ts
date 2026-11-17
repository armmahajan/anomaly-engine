import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { applyBatch, fixtureSliceProject, toRuntimeProject, type OperationCall, type ProjectSpec } from "@anomaly/core";
import { arena, FPS, type Sample, type Scenario } from "./simulate.ts";

// Game art in play, probed headless through game/tests/art_probe.gd: props drawn
// with kit pieces fitted to their rectangles (hidden ones not drawn), a modal's
// image (also when it arrives after the modal opened) and the HUD's held items.

const GAME_DIR = fileURLToPath(new URL("..", import.meta.url));
type Drawn = { id: string; shown: boolean; art: string | null; rect: [number, number, number, number] };
type Probed = Sample & { drawn: Drawn[]; held: { id: string; count: number; icon: boolean }[]; screen: { modal: { id: string; image: boolean } | null } };
type Case = Omit<Scenario, "samples"> & { samples: number[]; textures?: Record<string, [number, number]>; late?: Record<number, Record<string, [number, number]>> };

function probe(cases: Case[]): Probed[][] {
  const dir = mkdtempSync(join(tmpdir(), "anomaly-art-"));
  try {
    const scenarios = cases.map(({ project, ...rest }) => ({ ...rest, project: toRuntimeProject(project) }));
    writeFileSync(join(dir, "in.json"), JSON.stringify({ scenarios }));
    const run = spawnSync(
      process.env.GODOT ?? "godot",
      ["--headless", "--fixed-fps", String(FPS), "--path", GAME_DIR, "--script", "res://tests/art_probe.gd", "--", join(dir, "in.json"), join(dir, "out.json")],
      { encoding: "utf8", timeout: 60_000 },
    );
    const errors = `${run.stdout}${run.stderr}`.split("\n").filter((line) => /SCRIPT ERROR|^ERROR/.test(line));
    if (run.status !== 0 || errors.length) throw new Error(`art probe failed (${run.status}):\n${errors.join("\n")}`);
    const { results } = JSON.parse(readFileSync(join(dir, "out.json"), "utf8")) as { results: { error: string; samples: Probed[] }[] };
    return results.map((r, i) => {
      if (r.error) throw new Error(`case ${i}: ${r.error}`);
      return r.samples;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function build(base: ProjectSpec, calls: OperationCall[]): ProjectSpec {
  const result = applyBatch(base, calls);
  if (!result.ok) throw new Error(`${result.error.message} ${JSON.stringify(result.error.issues)}`);
  return result.project;
}

const REF = (n: number) => `${String(n).repeat(16)}.png`;
const [WIDE, TALL, TITLE, ICON] = [REF(3), REF(4), REF(5), REF(6)];
const piece = (id: string, file: string, width: number, height: number) => ({ id, file, name: id, kind: "decor", width, height, size: height });
const art = (roomId: string, propId: string, p: string): OperationCall => ({ name: "updateProp", input: { roomId, propId, changes: { art: { biome: "cave", piece: p } } } });

/** The slice with a biome whose pieces draw the hall's props, a hidden prop with art, and an illustrated title. */
const slice = build(fixtureSliceProject(), [
  { name: "createAsset", input: { asset: { id: "cave", name: "Cave", kind: "biome", brief: "a cave" } } },
  { name: "setBiomeKit", input: { assetId: "cave", kit: { backdrop: REF(1), ground: REF(2), pieces: [piece("slab", WIDE, 64, 32), piece("post", TALL, 16, 24)] } } },
  art("hall", "hatch", "slab"), // 96x12 from a 2:1 piece: stretched 1.5x at most, then kept in shape
  art("hall", "lock", "post"), // 32x64 from a 2:3 piece: close enough to fill it
  { name: "addProp", input: { roomId: "hall", id: "ghost", x: 200, y: 300, width: 32, height: 32, visible: false, art: { biome: "cave", piece: "post" } } },
  { name: "updateModal", input: { modalId: "title", changes: { image: TITLE } } },
]);

/** The arena with two items given at the start, one with an icon. */
const holding = build(arena([]), [
  { name: "createItem", input: { id: "ember", name: "Ember", color: "#ff7733" } },
  { name: "createItem", input: { id: "feather", name: "Feather" } },
  { name: "updateItem", input: { itemId: "feather", changes: { icon: ICON } } },
  { name: "setHandlers", input: { handlers: [{ on: { type: "gameStarted" }, do: [{ type: "giveItem", item: "ember" }, { type: "giveItem", item: "ember" }, { type: "giveItem", item: "feather" }] }] } },
]);

let props: Probed[];
let items: Probed[];
beforeAll(() => {
  [props, items] = probe([
    {
      project: slice,
      world: { room: "hall", x: 96, y: 384, abilities: [] },
      textures: { [WIDE]: [64, 32], [TALL]: [16, 24] },
      late: { 20: { [TITLE]: [96, 64] } },
      frames: 60,
      samples: [10, 30, 60],
      input: [{ action: "jump", from: 40, to: 43 }],
    },
    { project: holding, textures: { [ICON]: [32, 32] }, frames: 10, samples: [10] },
  ]) as [Probed[], Probed[]];
}, 120_000);

describe("game art in the runtime", () => {
  it("draws props with their kit pieces, fitted to their rectangles; hidden props aren't drawn", () => {
    const drawn = (id: string) => props.at(-1)!.drawn.find((d) => d.id === id)!;
    expect(drawn("hatch")).toEqual({ id: "hatch", shown: true, art: "slab", rect: [990, 384, 36, 12] });
    expect(drawn("lock")).toEqual({ id: "lock", shown: true, art: "post", rect: [27 * 32, 10 * 32, 32, 64] });
    expect(drawn("ghost")).toMatchObject({ shown: false, art: "post" });
  });

  it("shows a modal's image, also one that arrives after the modal opened", () => {
    expect(props[0]!.screen.modal).toMatchObject({ id: "title", image: false });
    expect(props[1]!.screen.modal).toMatchObject({ id: "title", image: true });
    expect(props[2]!.screen.modal).toBeNull();
  });

  it("shows the items the player holds in the HUD, with icons where they have them", () => {
    expect(items[0]!.held).toEqual([
      { id: "ember", count: 2, icon: false },
      { id: "feather", count: 1, icon: true },
    ]);
  });
});
