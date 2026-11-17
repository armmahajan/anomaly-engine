import { describe, expect, it } from "vitest";
import {
  applyOperation,
  CLIP_SLOTS,
  clipSlotsFor,
  exampleClips,
  exampleRig,
  fixtureSliceProject,
  gameArtPlan,
  lintProject,
  ProjectSpec,
  Rig,
  roomGroups,
  wantedClipSlots,
  type OperationResult,
} from "../src/index.ts";

const REF = (n: number) => `${String(n).repeat(16)}.png`;
function ok(result: OperationResult): ProjectSpec {
  if (!result.ok) throw new Error(`${result.error.message}: ${JSON.stringify(result.error.issues)}`);
  return result.project;
}

describe("attack clips", () => {
  it("are picked by the attack's phase, then the action's slots", () => {
    expect(clipSlotsFor("strike", "windup")).toEqual(["windup", "attack"]);
    expect(clipSlotsFor("strike", "active")).toEqual(["strike", "attack"]);
    expect(clipSlotsFor("summon", "active")).toEqual(["cast", "windup"]);
    expect(clipSlotsFor("patrol", null, true)).toEqual(["fly", "walk", "run"]);
  });

  it("every enemy wants a death clip (plays once); the player doesn't; all slots fit one 96-frame filmstrip", () => {
    const p = fixtureSliceProject();
    const drawn = { ...p, characters: p.characters.map((c) => ({ ...c, appearance: `look_${c.id}` })) };
    for (const c of drawn.characters) {
      expect(wantedClipSlots(drawn, c.appearance!).includes("death")).toBe(c.kind === "enemy");
    }
    expect(CLIP_SLOTS.death).toMatch(/once/);
    expect(Object.keys(CLIP_SLOTS).length * 6).toBeLessThanOrEqual(96); // render_service.gd MAX_FRAMES, 6 frames a clip
    const example = exampleClips().death!;
    expect(example.loop).toBe(false);
  });

  it("an enemy drawn before death clips existed gets an animate step for only the missing clips", () => {
    const p = fixtureSliceProject();
    const clips = exampleClips();
    const asset = { id: "look", name: "Look", kind: "character", brief: "", concepts: [], chosen: null, rig: exampleRig(), preview: null, clipPreviews: {}, stateClips: {} };
    const crawler = p.characters.find((c) => c.id === "crawler")!;
    const wanted = wantedClipSlots({ ...p, characters: [{ ...crawler, appearance: "look" }] }, "look");
    const old = Object.fromEntries(wanted.filter((s) => s !== "death").map((s) => [s, clips.idle!]));
    const project = ProjectSpec.parse({
      ...p,
      characters: p.characters.map((c) => (c.id === "crawler" ? { ...c, appearance: "look" } : c)),
      art: { ...p.art, assets: [{ ...asset, clips: old }] },
    });
    const step = gameArtPlan(project).find((s) => s.id === "character:crawler")!;
    expect(step).toMatchObject({ reason: "incomplete", request: { stage: "animate", characterId: "crawler", slots: ["death"] } });
  });

  it("are all asked for when animating a character with attacks", () => {
    const p = fixtureSliceProject();
    const withArt = { ...p, characters: p.characters.map((c) => (c.id === "guardian" ? { ...c, appearance: "g" } : c)) };
    expect(wantedClipSlots(withArt, "g").sort()).toEqual(["death", "hurt", "idle", "recover", "run", "slam", "strike", "windup"].sort());
  });
});

describe("the game-art plan", () => {
  const slice = fixtureSliceProject();

  it("lists everything an undrawn game needs, biome before rooms before props", () => {
    const steps = gameArtPlan(slice);
    const ids = steps.map((s) => s.id);
    expect(ids.filter((id) => id.startsWith("character:"))).toEqual(["character:player", "character:crawler", "character:guardian"]);
    expect(ids).toContain("biome:world");
    expect(ids.indexOf("biome:world")).toBeLessThan(ids.indexOf("room:entrance"));
    expect(ids.indexOf("room:hall")).toBeLessThan(ids.indexOf("props:hall"));
    expect(steps.find((s) => s.id === "room:hall")!.request).toEqual({ stage: "worldCompose", biomeStep: "biome:world", dressRoom: "hall" });
    expect(ids.filter((id) => id.startsWith("modal:"))).toHaveLength(4);
    expect(ids).toContain("items");
    expect(steps.every((s) => s.estimatedCost > 0)).toBe(true);
    expect(gameArtPlan(slice, { modals: false }).some((s) => s.kind === "modal")).toBe(false);
  });

  it("groups rooms by progression region", () => {
    expect(roomGroups(slice)).toEqual([{ group: "world", rooms: slice.world.rooms.map((r) => r.id) }]);
  });

  it("recomposes rooms whose tiles changed after they were dressed, and lint says so", () => {
    let p = withBiome(slice);
    p = ok(applyOperation(p, "setDressing", { worldRoomId: "hall", biomeId: "cave", roomId: "hall_art" }));
    expect(gameArtPlan(p).find((s) => s.id === "room:hall")).toBeUndefined();
    expect(lintProject(p).map((w) => w.code)).not.toContain("dressing_out_of_date");
    p = ok(applyOperation(p, "paintTiles", { roomId: "hall", kind: "solid", cells: [[5, 5]] }));
    expect(lintProject(p).map((w) => w.code)).toContain("dressing_out_of_date");
    expect(gameArtPlan(p).find((s) => s.id === "room:hall")).toMatchObject({ reason: "out_of_date", request: { stage: "worldCompose", biomeId: "cave", roomId: "hall_art" } });
    // The other rooms of the group use the biome already there instead of a new one.
    expect(gameArtPlan(p).find((s) => s.id === "room:entrance")!.request).toEqual({ stage: "worldCompose", biomeId: "cave", dressRoom: "entrance" });
    expect(gameArtPlan(p).some((s) => s.kind === "biome")).toBe(false);
  });
});

describe("cutout rigs", () => {
  it("draw pieces of a source image, which they must have", () => {
    const rig = exampleRig();
    const cutout = { ...rig, mode: "cutout", source: { file: REF(5), scale: 0.25, anchor: [256, 480] }, parts: [{ ...rig.parts[0]!, shape: { type: "image", points: [[0, 0], [10, 0], [10, -10]] } }] };
    expect(Rig.safeParse(cutout).success).toBe(true);
    const { source: _s, ...noSource } = cutout;
    expect(Rig.safeParse(noSource).success).toBe(false);
    expect(Rig.safeParse({ ...noSource, mode: undefined }).success).toBe(false); // image parts need a source in any mode
  });
});

/** The slice with a biome "cave" that has a kit and one composed room "hall_art". */
function withBiome(p: ProjectSpec): ProjectSpec {
  const composition = { palette: { ambient: "#8090a0", fog: "#3a5068", light: "#ffd9a0", shadow: "#05070a" }, placements: [], lights: [], fog: { mid: 0.5, back: 0.3, play: 0.2 }, rays: [], dust: { color: "#ffe2b0", amount: 60 } };
  let next = ok(applyOperation(p, "createAsset", { asset: { id: "cave", name: "Cave", kind: "biome", brief: "a cave" } }));
  next = ok(applyOperation(next, "setBiomeKit", { assetId: "cave", kit: { backdrop: REF(1), ground: REF(2), quality: "draft", pieces: [{ id: "s0_rock", file: REF(3), name: "Rock", kind: "structure", width: 100, height: 100, size: 120 }] } }));
  return ok(applyOperation(next, "addRoom", { assetId: "cave", room: { id: "hall_art", name: "Hall", composition, at: "2026-11-17T00:00:00Z" } }));
}
