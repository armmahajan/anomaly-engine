import { describe, expect, it } from "vitest";
import {
  applyOperation,
  Clip,
  createDefaultProject,
  Effect,
  fixtureAnimatedProject,
  fixtureReferenceProject,
  GameEvent,
  lintProject,
  objectUses,
  ProjectSpec,
  usedObjects,
  wantedObjectClips,
  WeaponProjectile,
  type OperationResult,
} from "../src/index.ts";

// Phase 0 of the animation target: the contracts (core art/animation.ts) and the shared fixture.

const ok = (r: OperationResult): ProjectSpec => {
  if (!r.ok) throw new Error(`${r.error.message} ${JSON.stringify(r.error.issues)}`);
  return r.project;
};
const codes = (p: ProjectSpec) => lintProject(p).map((w) => w.code);

describe("animation contracts", () => {
  it("old projects parse unchanged: clips get no markers, projectiles the default look, assets stay characters", () => {
    const ref = fixtureReferenceProject();
    expect(ProjectSpec.parse(ref)).toEqual(ref);
    expect(Clip.parse({ duration: 1, loop: true }).markers).toEqual([]);
    expect(WeaponProjectile.parse({}).look).toEqual({ origin: [0, 0], appear: "fire", art: null });
    const p = ok(applyOperation(createDefaultProject(), "createAsset", { asset: { id: "look", name: "Look", kind: "character", brief: "" } }));
    expect(p.art.assets[0]).toMatchObject({ kind: "character", subject: "character" });
  });

  it("the shared fixture is valid, lint-free for animation, and uses every primitive", () => {
    const p = fixtureAnimatedProject();
    expect(ProjectSpec.safeParse(p).success).toBe(true);
    expect(codes(p).filter((c) => c.startsWith("anim_") || c.startsWith("object_"))).toEqual([]);
    expect(usedObjects(p).map((a) => a.id).sort()).toEqual(["bolt", "lever", "shockwave", "trap"]);
    expect(wantedObjectClips(p, "trap").sort()).toEqual(["idle", "snap"]);
    expect(wantedObjectClips(p, "bolt").sort()).toEqual(["burst", "charge", "fly", "idle"]);
    expect(objectUses(p).find((u) => u.object === "shockwave")?.what).toBe("a spawnEffect");
  });

  it("new effects and the marker event parse with their defaults", () => {
    expect(Effect.parse({ type: "playAnimation", clip: "pull" })).toEqual({ type: "playAnimation", target: { kind: "self" }, clip: "pull", then: "idle" });
    expect(Effect.parse({ type: "spawnEffect", object: "shockwave" })).toEqual({ type: "spawnEffect", object: "shockwave", clip: "idle", at: { kind: "self" }, offset: [0, 0], scale: 1, layer: "front" });
    expect(GameEvent.parse({ type: "marker", name: "strike", from: { kind: "prop", prop: "trap" } })).toMatchObject({ type: "marker" });
    expect(Effect.safeParse({ type: "spawnEffect", object: "x", at: { kind: "point", x: 1 } }).success).toBe(false);
  });

  it("createObject, setClipMarkers (sorted, clip must exist), and deleting an object in use is refused", () => {
    let p = fixtureAnimatedProject();
    p = ok(applyOperation(p, "setClipMarkers", { assetId: "trap", clipId: "snap", markers: [{ t: 0.8, name: "reset" }, { t: 0.3, name: "strike" }] }));
    const trap = p.art.assets.find((a) => a.id === "trap");
    expect(trap?.kind === "character" && trap.clips.snap?.markers.map((m) => m.name)).toEqual(["strike", "reset"]);
    expect(applyOperation(p, "setClipMarkers", { assetId: "trap", clipId: "nope", markers: [] }).ok).toBe(false);
    expect(applyOperation(p, "setClipMarkers", { assetId: "trap", clipId: "snap", markers: [{ t: 1.5, name: "late" }] }).ok).toBe(false);
    const refused = applyOperation(p, "deleteAsset", { assetId: "trap" });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error.message).toContain('the prop "Trap"');
    const unused = ok(applyOperation(p, "createObject", { id: "spare", name: "Spare", brief: "a crate" }));
    expect(unused.art.assets.find((a) => a.id === "spare")).toMatchObject({ kind: "character", subject: "object", rig: null });
    expect(ok(applyOperation(unused, "deleteAsset", { assetId: "spare" })).art.assets.some((a) => a.id === "spare")).toBe(false);
  });

  it("prop object art must name an object asset; kit art still names a kit piece", () => {
    const p = fixtureAnimatedProject();
    expect(applyOperation(p, "updateProp", { roomId: "arena", propId: "trap", changes: { art: { object: "charger_look" } } }).ok).toBe(false);
    expect(applyOperation(p, "updateProp", { roomId: "arena", propId: "trap", changes: { art: { object: "lever" } } }).ok).toBe(true);
    expect(applyOperation(p, "updateProp", { roomId: "arena", propId: "trap", changes: { art: { biome: "nope", piece: "x" } } }).ok).toBe(false);
  });

  it("lint: unknown objects and clips, self outside a prop or spawn, targets not in the room, playAnimation on a prop without an object", () => {
    let p = fixtureAnimatedProject();
    p = ok(applyOperation(p, "addHandler", { roomId: "arena", handler: { on: { type: "roomEntered" }, do: [{ type: "playAnimation", clip: "snap" }] } }));
    p = ok(applyOperation(p, "addHandler", { roomId: "arena", handler: { on: { type: "roomEntered" }, do: [{ type: "playAnimation", target: { kind: "prop", prop: "ghost" }, clip: "snap" }] } }));
    p = ok(applyOperation(p, "addHandler", { roomId: "arena", handler: { on: { type: "roomEntered" }, do: [{ type: "playAnimation", target: { kind: "prop", prop: "trap" }, clip: "dance" }] } }));
    p = ok(applyOperation(p, "addHandler", { roomId: "arena", handler: { on: { type: "roomEntered" }, do: [{ type: "playAnimation", target: { kind: "prop", prop: "door" }, clip: "open" }] } }));
    p = ok(applyOperation(p, "addHandler", { roomId: "arena", handler: { on: { type: "roomEntered" }, do: [{ type: "spawnEffect", object: "charger_look" }] } }));
    const c = codes(p);
    for (const code of ["anim_self_outside", "anim_target_unknown", "anim_clip_unknown", "anim_prop_not_object", "object_unknown"]) expect(c).toContain(code);
  });
});
