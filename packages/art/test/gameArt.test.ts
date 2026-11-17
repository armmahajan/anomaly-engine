import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyBatch,
  applyOperation,
  doorBlockers,
  dressingOutOfDate,
  fixtureSliceProject,
  gameArtPlan,
  gridPlatforms,
  gridSize,
  lintProject,
  passageIntrusion,
  ProjectSpec,
  roomFingerprint,
  type ArtStepRequest,
  type BiomeAsset,
  type FileRef,
  type OperationCall,
  type SnapRoom,
  type WorldRoom,
} from "@anomaly/core";
import { FakeImageModel, FakeRenderer, FakeVisionModel, itemArtStage, modalArtStage, propArtStage, worldComposeStage, worldKitStage, type ArtContext } from "../src/index.ts";
import type { VisionReply, VisionRequest } from "../src/models.ts";

/** Composes rooms that crowd every edge (where doors are) and hang a long vine into the room. */
class CrowdingVision extends FakeVisionModel {
  /** Replies for the prop picker, by prop id (default: the kit's first piece). */
  picks: Record<string, unknown> = {};

  override async complete(request: VisionRequest): Promise<VisionReply> {
    const prompt = request.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    const usage = { cost: 0.001, promptTokens: 1000, completionTokens: 400 };
    const size = /Compose one room (\d+)px wide and (\d+)px tall/.exec(prompt);
    if (size) {
      const [w, h] = [Number(size[1]), Number(size[2])];
      const at = (piece: string, layer: string, x: number, y: number, scale = 1) => ({ piece, layer, x, y, scale, flip: false });
      const placements = [
        at("p1_mushrooms", "play", 40, h),
        at("p1_mushrooms", "play", w - 40, h),
        at("p0_lantern", "play", w / 2, h),
        at("s0_tall_pillar", "front", 40, h + 40),
        at("s0_tall_pillar", "back", w - 30, h),
        at("s0_tall_pillar", "mid", w / 2, h, 1.5),
        at("s1_root_curtain", "play", w / 2 + 120, 0, 1.6),
        ...[3, 8, 12, 20, 28, 31].map((col) => at("s1_root_curtain", "front", col * 32, 0)),
      ];
      const reply = { palette: { ambient: "#8090a0", fog: "#3a5068", light: "#ffd9a0", shadow: "#05070a" }, placements, lights: [], fog: { mid: 0.4, back: 0.3, play: 0.2 }, rays: [], dust: { color: "#ffe2b0", amount: 60 } };
      this.requests.push(request);
      return { text: JSON.stringify(reply), usage, model: this.id };
    }
    if (prompt.includes("Choose a sprite for each object")) {
      this.requests.push(request);
      const props = JSON.parse(prompt.split("Props (JSON): ")[1]!.split("\n")[0]!) as { id: string }[];
      return { text: JSON.stringify({ props: props.map((p) => this.picks[p.id] ?? { id: p.id, piece: "p1_mushrooms" }) }), usage, model: this.id };
    }
    return super.complete(request);
  }
}

function harness(start: ProjectSpec = fixtureSliceProject()) {
  let project = start;
  const files = new Map<string, Buffer>();
  const image = new FakeImageModel();
  const vision = new CrowdingVision();
  const log: string[] = [];
  const ctx: ArtContext = {
    project: () => project,
    image,
    vision,
    renderer: new FakeRenderer(),
    files: {
      async put(data: Buffer, ext: "png" | "jpg" | "webp"): Promise<FileRef> {
        const ref = `${createHash("sha256").update(data).digest("hex").slice(0, 32)}.${ext}`;
        files.set(ref, data);
        return ref;
      },
      async get(ref: FileRef) {
        const data = files.get(ref);
        if (!data) throw new Error(`no file ${ref}`);
        return data;
      },
    },
    log: (a) => log.push(a.text),
    remaining: () => 1,
    spend: () => {},
  };
  const commit = (operations: OperationCall[]) => {
    if (operations.length === 0) return;
    const result = applyBatch(project, operations);
    if (!result.ok) throw new Error(`${result.error.message} ${JSON.stringify(result.error.issues)}`);
    project = result.project;
  };
  const edit = (name: string, input: unknown) => {
    const result = applyOperation(project, name, input);
    if (!result.ok) throw new Error(result.error.message);
    project = result.project;
  };
  return { ctx, commit, edit, files, image, vision, log, project: () => project };
}
type Harness = ReturnType<typeof harness>;

/** Run the plan's world steps (biomes, then rooms) the way the game-art job does: an earlier biome step names the biome later ones use. */
async function drawWorld(h: Harness) {
  const biomes: Record<string, string> = {};
  for (const step of gameArtPlan(h.project())) {
    const request: ArtStepRequest = step.request;
    if (request.stage === "worldKit") {
      const result = await worldKitStage(h.ctx, { theme: request.brief, name: request.name });
      h.commit(result.operations);
      biomes[step.id] = result.biomeId;
    } else if (request.stage === "worldCompose") {
      const biomeId = request.biomeId ?? biomes[request.biomeStep!]!;
      h.commit((await worldComposeStage(h.ctx, { biomeId, dressRoom: request.dressRoom, roomId: request.roomId })).operations);
    }
  }
}

const snapRoom = (project: ProjectSpec, room: WorldRoom): SnapRoom => {
  const size = gridSize(room.grid);
  return { width: Math.max(960, size.width), height: Math.max(360, size.height), platforms: gridPlatforms(room.grid, project.world.ledgeThickness) };
};
const biomeRoomOf = (project: ProjectSpec, room: WorldRoom) => {
  const biome = project.art.assets.find((a) => a.id === room.dressing?.biome) as BiomeAsset;
  return { biome, composition: biome.rooms.find((r) => r.id === room.dressing!.room)!.composition };
};

describe("drawing a whole world", () => {
  it("dresses every room around its own tiles, keeping doors and passages clear", async () => {
    const h = harness();
    await drawWorld(h);
    const project = h.project();
    expect(project.art.assets.filter((a) => a.kind === "biome")).toHaveLength(1);
    for (const room of project.world.rooms) {
      expect(room.dressing?.tiles, room.id).toBe(roomFingerprint(room));
      const { biome, composition } = biomeRoomOf(project, room);
      expect(biome.rooms.find((r) => r.id === room.dressing!.room)!.name).toBe(room.name);
      const shape = snapRoom(project, room);
      expect(doorBlockers(composition.placements, biome.kit!.pieces, shape, room.doors), room.id).toEqual([]);
      for (const p of composition.placements) expect(passageIntrusion(p, biome.kit!.pieces.find((k) => k.id === p.piece)!, shape), `${room.id} ${p.id}`).toBeLessThanOrEqual(0);
      // Not everything was thrown away: the middle of the room is still dressed.
      expect(composition.placements.some((p) => p.piece === "p0_lantern"), room.id).toBe(true);
    }
    expect(h.log.some((l) => /^paths: .*off doorways/.test(l))).toBe(true);
    expect(h.log.some((l) => /^paths: .*shortened/.test(l))).toBe(true);
    // The doors are named in the compose prompt too.
    const composes = h.vision.requests.filter((r) => r.content.some((c) => c.type === "text" && c.text.includes("Compose one room")));
    expect(composes.every((r) => r.content.some((c) => c.type === "text" && c.text.includes("Door openings")))).toBe(true);
    expect(gameArtPlan(project).filter((s) => s.kind === "room" || s.kind === "biome")).toEqual([]);
    expect(lintProject(project).map((w) => w.code)).not.toContain("dressing_out_of_date");
  });

  it("recomposes a room whose tiles changed, which makes its dressing current again", async () => {
    const h = harness();
    await drawWorld(h);
    h.edit("paintTiles", { roomId: "hall", kind: "solid", cells: [[20, 11], [21, 11]] });
    expect(lintProject(h.project()).map((w) => w.code)).toContain("dressing_out_of_date");
    const step = gameArtPlan(h.project()).find((s) => s.id === "room:hall")!;
    expect(step.reason).toBe("out_of_date");
    const before = h.project().world.rooms.find((r) => r.id === "hall")!.dressing!;
    const result = await worldComposeStage(h.ctx, { biomeId: step.request.biomeId!, roomId: step.request.roomId });
    expect(result.operations.map((o) => o.name)).toEqual(["setRoomComposition", "setDressing"]);
    h.commit(result.operations);
    const hall = h.project().world.rooms.find((r) => r.id === "hall")!;
    expect(hall.dressing).toMatchObject({ biome: before.biome, room: before.room, tiles: roomFingerprint(hall) });
    expect(lintProject(h.project()).map((w) => w.code)).not.toContain("dressing_out_of_date");
    expect(gameArtPlan(h.project()).find((s) => s.id === "room:hall")).toBeUndefined();
  });

  it("gives a room of its own to one of several world rooms sharing a biome room when its tiles change", async () => {
    const h = harness();
    await drawWorld(h);
    const hall = h.project().world.rooms.find((r) => r.id === "hall")!.dressing!;
    h.edit("setDressing", { worldRoomId: "sanctum", biomeId: hall.biome, roomId: hall.room });
    h.edit("paintTiles", { roomId: "sanctum", kind: "solid", cells: [[10, 11]] });
    const step = gameArtPlan(h.project()).find((s) => s.id === "room:sanctum")!;
    const result = await worldComposeStage(h.ctx, { biomeId: step.request.biomeId!, roomId: step.request.roomId });
    expect(result.operations.map((o) => o.name)).toEqual(["addRoom"]);
    h.commit(result.operations);
    const rooms = h.project().world.rooms;
    expect(rooms.find((r) => r.id === "sanctum")!.dressing).toMatchObject({ room: result.roomId });
    expect(rooms.find((r) => r.id === "hall")!.dressing).toMatchObject(hall);
    expect(rooms.some(dressingOutOfDate)).toBe(false);
  });

  it("paints a region's biome from the plan, with no world room needed, and composes its rooms with it", async () => {
    let p = fixtureSliceProject();
    const region = applyOperation(p, "createRegion", { region: { id: "depths", name: "Fungal Depths", status: "canon" } });
    if (!region.ok) throw new Error(region.error.message);
    const regionId = region.project.progression.regions[0]!.id;
    p = ProjectSpec.parse({ ...region.project, world: { ...region.project.world, rooms: region.project.world.rooms.map((r) => (["cistern", "spikes"].includes(r.id) ? { ...r, regionId } : r)) } });
    const plan = gameArtPlan(p);
    const kitStep = plan.find((s) => s.id === `biome:${regionId}`)!;
    expect(kitStep.request.brief).toContain("Fungal Depths");

    // The kit stage alone works in a project without world rooms.
    const empty = harness(ProjectSpec.parse({ ...p, world: { ...p.world, rooms: [], start: null, playtest: null, handlers: [] } }));
    empty.commit((await worldKitStage(empty.ctx, { theme: kitStep.request.brief, name: kitStep.request.name })).operations);
    expect(empty.project().art.assets.find((a) => a.kind === "biome")).toMatchObject({ name: "Fungal Depths" });

    const h = harness(p);
    await drawWorld(h);
    const biomeOf = (id: string) => h.project().world.rooms.find((r) => r.id === id)!.dressing!.biome;
    expect(biomeOf("cistern")).toBe(biomeOf("spikes"));
    expect(biomeOf("cistern")).not.toBe(biomeOf("hall"));
    expect(h.project().art.assets.find((a) => a.id === biomeOf("cistern"))!.name).toBe("Fungal Depths");
  });
});

describe("props, screens and items", () => {
  it("draws every prop of a room with a kit piece, painting the ones nothing fits", async () => {
    const h = harness();
    await drawWorld(h);
    const hall = () => h.project().world.rooms.find((r) => r.id === "hall")!;
    expect(hall().props.length).toBeGreaterThan(1);
    const [painted, ...rest] = hall().props;
    h.vision.picks = { [painted!.id]: { id: painted!.id, piece: null, paint: { name: "Iron Hatch", description: "a riveted iron hatch", kind: "structure" } } };
    const pieces = (h.project().art.assets.find((a) => a.kind === "biome") as BiomeAsset).kit!.pieces.length;
    const result = await propArtStage(h.ctx, { worldRoomId: "hall" });
    h.commit(result.operations);
    const biome = h.project().art.assets.find((a) => a.kind === "biome") as BiomeAsset;
    expect(biome.kit!.pieces).toHaveLength(pieces + 1);
    const added = biome.kit!.pieces.at(-1)!;
    expect(added).toMatchObject({ id: "prop_iron_hatch", name: "Iron Hatch", kind: "structure", size: painted!.height });
    expect(hall().props.find((p) => p.id === painted!.id)!.art).toEqual({ biome: biome.id, piece: added.id });
    for (const prop of rest) expect(hall().props.find((p) => p.id === prop.id)!.art).toEqual({ biome: biome.id, piece: "p1_mushrooms" });
    // One cheap sheet, only for what was missing; the picker saw each prop's size and handlers as data.
    const sheet = h.image.requests.at(-1)!;
    expect(sheet).toMatchObject({ transparent: true, quality: "low" });
    expect(sheet.prompt).toContain("a riveted iron hatch");
    const asked = h.vision.requests.at(-1)!.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(asked).toContain(`${painted!.width}x${painted!.height}px`);
    expect(asked).toMatch(/interact.*: .*(showModal|setFlag)/);
    // Done: nothing left to draw, and the plan agrees.
    expect((await propArtStage(h.ctx, { worldRoomId: "hall" })).operations).toEqual([]);
    expect(gameArtPlan(h.project()).find((s) => s.id === "props:hall")).toBeUndefined();
    // Painted pieces survive a repaint of the kit's props sheet.
    const { worldRepaintStage } = await import("../src/index.ts");
    h.commit((await worldRepaintStage(h.ctx, { biomeId: biome.id, part: "props" })).operations);
    expect((h.project().art.assets.find((a) => a.id === biome.id) as BiomeAsset).kit!.pieces.some((p) => p.id === added.id)).toBe(true);
  });

  it("needs a biome for the room's props", async () => {
    const h = harness();
    await expect(propArtStage(h.ctx, { worldRoomId: "hall" })).rejects.toThrow(/dress Hall with a biome first/);
  });

  it("illustrates a modal from its title and text", async () => {
    const h = harness();
    const result = await modalArtStage(h.ctx, { modalId: "title" });
    h.commit(result.operations);
    const modal = h.project().world.modals.find((m) => m.id === "title")!;
    expect(modal.image && h.files.has(modal.image)).toBe(true);
    const prompt = h.image.requests[0]!.prompt;
    expect(prompt).toContain("Descent");
    expect(prompt).toContain("Find the way down");
    expect(prompt).toContain("No text");
    expect(gameArtPlan(h.project()).find((s) => s.id === "modal:title")).toBeUndefined();
  });

  it("draws icons for every item without one from one sheet", async () => {
    const h = harness();
    h.edit("createItem", { name: "Ember", description: "A warm coal", color: "#ff7733" });
    h.edit("createItem", { name: "Feather" });
    const result = await itemArtStage(h.ctx);
    h.commit(result.operations);
    expect(h.image.requests).toHaveLength(1);
    expect(h.image.requests[0]).toMatchObject({ transparent: true, quality: "low" });
    expect(h.image.requests[0]!.prompt).toMatch(/2x2 grid.*Key.*Ember \(A warm coal\).*Feather/);
    const icons = h.project().world.items.map((i) => i.icon);
    expect(icons).toHaveLength(3);
    for (const icon of icons) expect(icon && h.files.has(icon)).toBe(true);
    expect(new Set(icons).size).toBe(3);
    expect(gameArtPlan(h.project()).some((s) => s.kind === "items")).toBe(false);
    expect((await itemArtStage(h.ctx)).operations).toEqual([]);
  });

  it("paints a thing again on its own when its cell of the sheet comes back empty", async () => {
    const h = harness();
    h.edit("createItem", { name: "Ember" });
    // Only the first cell has anything in it.
    const renderer = h.ctx.renderer as FakeRenderer;
    const slice = renderer.sliceGrid.bind(renderer);
    renderer.sliceGrid = async (image, cols, rows) => (await slice(image, cols, rows)).slice(0, 1);
    h.commit((await itemArtStage(h.ctx)).operations);
    expect(h.image.requests.map((r) => r.prompt.slice(0, 40))).toEqual(["Sprite sheet: a 2x2 grid of separate ite", "Sprite sheet: one item icon for a 2D pla"]);
    expect(h.image.requests[1]!.prompt).toContain("Ember");
    expect(h.project().world.items.every((i) => i.icon)).toBe(true);
    expect(h.log).toContain('the cell for "Ember, mostly #e8c547" came back empty; painting it on its own');
  });
});
