import { describe, expect, it } from "vitest";
import { applyBatch, applyOperation, createDefaultProject, lintProject, migrateProject, ProjectSpec, worldSceneFor, type BiomeAsset, type OperationResult, type ProjectSpec as Project } from "../src/index.ts";

const REF = (n: number) => `${String(n).repeat(16)}.png`;

function ok(result: OperationResult): Project {
  if (!result.ok) throw new Error(`${result.error.message}: ${JSON.stringify(result.error.issues)}`);
  return result.project;
}

const composition = {
  palette: { ambient: "#8090a0", fog: "#3a5068", light: "#ffd9a0", shadow: "#05070a" },
  placements: [
    { piece: "s0_pillar", layer: "mid", x: 300, y: 660, scale: 1.5, flip: false },
    { piece: "p0_lantern", layer: "play", x: 500, y: 660, scale: 1, flip: false },
  ],
  lights: [],
  fog: { mid: 0.5, back: 0.3, play: 0.2 },
  rays: [],
  dust: { color: "#ffe2b0", amount: 60 },
};

/** Default project + a biome with a kit and one room. */
function withBiome(): Project {
  return ok(
    applyBatch(createDefaultProject(), [
      { name: "createAsset", input: { asset: { id: "cathedral", name: "Cathedral", kind: "biome", brief: "a fungal cathedral" } } },
      {
        name: "setBiomeKit",
        input: {
          assetId: "cathedral",
          kit: {
            backdrop: REF(1),
            ground: REF(2),
            quality: "draft",
            pieces: [
              { id: "s0_pillar", file: REF(3), name: "Pillar", kind: "structure", width: 100, height: 400, size: 420 },
              { id: "p0_lantern", file: REF(4), name: "Lantern", kind: "light", width: 40, height: 60, size: 48, glow: "#ffcc80" },
            ],
          },
        },
      },
      {
        name: "addRoom",
        input: {
          assetId: "cathedral",
          dressArena: true,
          room: { id: "hall", name: "Hall", composition, layout: [{ x: 0, y: 600, width: 1600, height: 120 }], at: "2026-11-16T00:00:00Z" },
        },
      },
    ]),
  );
}
const biome = (p: Project) => p.art.assets.find((a) => a.id === "cathedral") as BiomeAsset;

describe("world data", () => {
  it("gives rooms placement ids and dresses the arena", () => {
    const project = withBiome();
    expect(biome(project).rooms[0]!.composition.placements.map((p) => p.id)).toEqual(["pl_1", "pl_2"]);
    expect(project.sandbox.dressing).toEqual({ biome: "cathedral", room: "hall" });
  });

  it("leaves breakable platforms out of the room's scene (they keep their own look and can disappear)", () => {
    const project = withBiome();
    const floor = { x: 0, y: 660, width: 1600, height: 60 };
    const withBreakable: Project = { ...project, sandbox: { ...project.sandbox, platforms: [floor, { x: 600, y: 480, width: 120, height: 24, breakable: true }] } };
    expect(worldSceneFor(withBreakable, "cathedral", "hall")?.platforms).toEqual([floor]);
  });

  it("old projects load without a dressing", () => {
    const { dressing: _d, ...sandbox } = createDefaultProject().sandbox;
    expect(ProjectSpec.parse({ ...createDefaultProject(), sandbox }).sandbox.dressing).toBeNull();
  });

  it("edits placements by id: move, re-layer, add, remove", () => {
    let project = withBiome();
    project = ok(applyOperation(project, "updatePlacement", { assetId: "cathedral", roomId: "hall", placementId: "pl_2", changes: { x: 640, layer: "back" } }));
    project = ok(applyOperation(project, "addPlacement", { assetId: "cathedral", roomId: "hall", placement: { piece: "p0_lantern", layer: "play", x: 900, y: 660 } }));
    project = ok(applyOperation(project, "removePlacement", { assetId: "cathedral", roomId: "hall", placementId: "pl_1" }));
    expect(biome(project).rooms[0]!.composition.placements).toMatchObject([
      { id: "pl_2", x: 640, layer: "back" },
      { id: "pl_3", piece: "p0_lantern", x: 900 },
    ]);
    const unknown = applyOperation(project, "addPlacement", { assetId: "cathedral", roomId: "hall", placement: { piece: "nope", layer: "play", x: 0, y: 0 } });
    expect(!unknown.ok && unknown.error.message).toMatch(/no piece "nope"/);
  });

  it("changes atmosphere by merging", () => {
    const project = ok(applyOperation(withBiome(), "updateRoom", { assetId: "cathedral", roomId: "hall", changes: { fog: { mid: 0.2 }, palette: { ambient: "#a0a0b0" } } }));
    expect(biome(project).rooms[0]!.composition.fog).toEqual({ mid: 0.2, back: 0.3, play: 0.2 });
    expect(biome(project).rooms[0]!.composition.palette.ambient).toBe("#a0a0b0");
  });

  it("accepting a suggested layout replaces the arena's platforms (one undoable step)", () => {
    const project = ok(applyOperation(withBiome(), "applyRoomLayout", { assetId: "cathedral", roomId: "hall" }));
    expect(project.sandbox.platforms).toEqual([{ x: 0, y: 600, width: 1600, height: 120 }]);
    expect(biome(project).rooms[0]!.layout).toBeNull();
  });

  it("deleting the dressed room or the biome undresses the arena; rooms need a kit", () => {
    expect(ok(applyOperation(withBiome(), "deleteRoom", { assetId: "cathedral", roomId: "hall" })).sandbox.dressing).toBeNull();
    expect(ok(applyOperation(withBiome(), "deleteAsset", { assetId: "cathedral" })).sandbox.dressing).toBeNull();
    expect(ok(applyOperation(withBiome(), "setDressing", { biomeId: null })).sandbox.dressing).toBeNull();
    const bare = ok(applyOperation(createDefaultProject(), "createAsset", { asset: { id: "b", name: "B", kind: "biome", brief: "x" } }));
    expect(applyOperation(bare, "addRoom", { assetId: "b", room: {} }).ok).toBe(false);
    expect(lintProject(withBiome()).filter((w) => w.path.startsWith("art"))).toEqual([]);
  });
});

describe("loading older projects", () => {
  it("snaps world pieces stranded outside their room back in, and leaves the rest alone", () => {
    const project = withBiome();
    const old = JSON.parse(JSON.stringify({ ...project, schemaVersion: 3 }));
    const placements = old.art.assets.find((a: { id: string }) => a.id === "cathedral").rooms[0].composition.placements;
    placements[0].y = 0; // the mid pillar, wholly above the room's top
    const migrated = ProjectSpec.parse(migrateProject(old));
    expect(migrated.schemaVersion).toBe(4);
    const [pillar, lantern] = biome(migrated).rooms[0]!.composition.placements;
    expect(pillar).toMatchObject({ id: "pl_1", x: 300, y: 660 });
    expect(lantern).toEqual(biome(project).rooms[0]!.composition.placements[1]);
  });
});
