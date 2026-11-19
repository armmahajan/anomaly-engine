import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyBatch, exampleRig, fixtureAnimatedProject, isObjectAsset, ProjectSpec, type CharacterAsset, type Clip, type FileRef, type OperationCall } from "@anomaly/core";
import {
  animate,
  buildRig,
  chooseConcept,
  cleanMarkers,
  drawCreature,
  encodePng,
  FakeImageModel,
  FakeRenderer,
  FakeVisionModel,
  generateConcepts,
  heardMarkers,
  motionStops,
  objectClipModes,
  OBJECT_RIG,
  settleMarkers,
  settleObjectClips,
  type ArtActivity,
  type ArtContext,
} from "../src/index.ts";

/** The animation fixture with some objects not drawn yet (no rig, no clips). */
function undrawn(...ids: string[]): ProjectSpec {
  const p = fixtureAnimatedProject();
  return ProjectSpec.parse({
    ...p,
    art: { ...p.art, assets: p.art.assets.map((a) => (ids.includes(a.id) ? { ...a, rig: null, clips: {}, clipPreviews: {}, preview: null } : a)) },
  });
}

function harness(start: ProjectSpec, options: { defaultRigMode?: ArtContext["defaultRigMode"] } = {}) {
  let project = start;
  const files = new Map<string, Buffer>();
  const log: ArtActivity[] = [];
  const vision = new FakeVisionModel();
  const image = new FakeImageModel();
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
    log: (a) => log.push(a),
    remaining: () => 1,
    spend: () => {},
    ...options,
  };
  const commit = (operations: OperationCall[]) => {
    const result = applyBatch(project, operations);
    if (!result.ok) throw new Error(`${result.error.message} ${JSON.stringify(result.error.issues)}`);
    project = result.project;
  };
  const asset = (id: string) => project.art.assets.find((a) => a.id === id) as CharacterAsset;
  const prompts = () => vision.requests.flatMap((r) => [r.system ?? "", ...r.content.map((c) => (c.type === "text" ? c.text : ""))]).join("\n");
  return { ctx, commit, log, vision, image, asset, prompts, project: () => project };
}

describe("objects in the art pipeline", () => {
  it("a lever goes from concepts to clips like a character: object prompts, hinges not limbs, idle plus the clips the game plays, validated markers", async () => {
    const h = harness(undrawn("lever"));
    const concepts = await generateConcepts(h.ctx, { objectId: "lever" });
    // The object asset already exists (createObject): no new asset, nothing assigned to a character.
    expect(concepts.operations.map((o) => o.name)).toEqual(["addConcept"]);
    expect(concepts.assetId).toBe("lever");
    h.commit(concepts.operations);
    const sheetPrompt = h.image.requests[0]!.prompt;
    expect(sheetPrompt).toContain("a rusted floor lever with a red knob");
    expect(sheetPrompt).toMatch(/animated object/);
    expect(sheetPrompt).not.toMatch(/Hands empty|full-body|head toward|arms hanging/i);

    h.commit((await chooseConcept(h.ctx, { objectId: "lever" })).operations);
    expect(h.asset("lever").chosen).toBeTruthy();
    expect(h.prompts()).toContain("Which way does this object point");

    // The default rig mode, as for characters (vector here): a flat redraw, then the rig, then details.
    const rig = await buildRig(h.ctx, { objectId: "lever" });
    expect(rig.operations.map((o) => o.name)).toEqual(["chooseConcept", "setRig"]);
    h.commit(rig.operations);
    expect(h.image.requests.at(-1)!.prompt).toMatch(/^Redraw the attached object/);
    expect(h.prompts()).toContain(OBJECT_RIG);
    expect(h.prompts()).not.toMatch(/Split every arm and leg|Leave out weapons/);
    expect(h.asset("lever").rig?.grips ?? []).toEqual([]);
    expect(rig.summary).toMatch(/Lever's vector rig/);

    h.vision.requests.length = 0;
    const anim = await animate(h.ctx, { objectId: "lever" });
    h.commit(anim.operations);
    const lever = h.asset("lever");
    expect(Object.keys(lever.clips).sort()).toEqual(["idle", "pull"]);
    expect(lever.clips.idle!.loop).toBe(true);
    expect(lever.clips.pull!.loop).toBe(false); // played by a handler: once
    // The prompt says what the game listens for; no limbs, no weapon.
    expect(h.prompts()).toContain("The game listens for these markers on this object: click.");
    expect(h.prompts()).not.toMatch(/gripping|BEND|Limbs with two bones/);
    // The model's markers, validated: the malformed one dropped, times inside 0..1 and in order,
    // and the click moved onto the frame the pull lands.
    const markers = lever.clips.pull!.markers;
    expect(markers.map((m) => m.name)).toEqual(["start", "click"]);
    expect(markers[0]!.t).toBe(0);
    const click = markers[1]!.t;
    expect(click).toBeGreaterThan(0.4);
    expect(click).toBeLessThan(0.55);
    expect(motionStops(lever.rig!, lever.clips.pull!)).toContain(click);
    expect(Object.keys(lever.clipPreviews).sort()).toEqual(["idle", "pull"]);
  });

  it("a trap rigged as a cutout (the art direction's mode) gets idle and snap, with the strike its handler listens for", async () => {
    const h = harness(undrawn("trap"), { defaultRigMode: "cutout" });
    h.commit((await generateConcepts(h.ctx, { objectId: "trap" })).operations);
    h.commit((await chooseConcept(h.ctx, { objectId: "trap" })).operations);
    // The fake renderer's crops are blank: the chosen design is a drawn figure on a flat background instead.
    const file = await h.ctx.files.put(encodePng(drawCreature(256, 256)), "png");
    h.commit([{ name: "chooseConcept", input: { assetId: "trap", sheet: 0, cell: 0, file } }]);
    const rig = await buildRig(h.ctx, { objectId: "trap" });
    expect(rig.operations.map((o) => o.name)).toEqual(["setRig"]); // no flat redraw for a cutout
    h.commit(rig.operations);
    expect(h.asset("trap").rig?.mode).toBe("cutout");
    expect(h.prompts()).toMatch(/Plan the cutout rig for the object/);
    h.commit((await animate(h.ctx, { objectId: "trap" })).operations);
    const trap = h.asset("trap");
    expect(Object.keys(trap.clips).sort()).toEqual(["idle", "snap"]);
    expect(trap.clips.snap!.markers.map((m) => m.name)).toContain("strike");
    for (const m of trap.clips.snap!.markers) expect(m.t).toBeGreaterThanOrEqual(0), expect(m.t).toBeLessThanOrEqual(1);
  });

  it("projectile objects get charge, fly and burst; one clip can be redone from a direction", async () => {
    const h = harness(undrawn("bolt"));
    h.commit((await generateConcepts(h.ctx, { objectId: "bolt" })).operations);
    h.commit((await chooseConcept(h.ctx, { objectId: "bolt" })).operations);
    h.commit((await buildRig(h.ctx, { objectId: "bolt", redraw: false, detail: false })).operations);
    h.commit((await animate(h.ctx, { objectId: "bolt" })).operations);
    const bolt = h.asset("bolt");
    expect(Object.keys(bolt.clips).sort()).toEqual(["burst", "charge", "fly", "idle"]);
    expect([bolt.clips.charge!.loop, bolt.clips.fly!.loop, bolt.clips.burst!.loop]).toEqual([true, true, false]);

    h.vision.requests.length = 0;
    const redo = await animate(h.ctx, { objectId: "bolt", clip: "fizzle", direction: "sputters out and drops" });
    expect(redo.operations.map((o) => (o.input as { clipId: string }).clipId)).toEqual(["fizzle"]);
    expect((redo.operations[0]!.input as { clip: Clip }).clip.direction).toBe("sputters out and drops");
    expect(h.prompts()).toContain('"fizzle" (sputters out and drops;');
  });

  it("refuses an objectId that isn't an object asset, and weapon clips on an object", async () => {
    const h = harness(fixtureAnimatedProject());
    expect(isObjectAsset(h.asset("charger_look"))).toBe(false);
    await expect(generateConcepts(h.ctx, { objectId: "charger_look" })).rejects.toThrow(/not an object asset/);
    await expect(generateConcepts(h.ctx, { objectId: "nothing" })).rejects.toThrow(/no object "nothing"/);
    await expect(animate(h.ctx, { objectId: "bolt", weaponId: "sword" })).rejects.toThrow(/no weapon attack clips/);
  });
});

describe("object clips and markers", () => {
  const rig = exampleRig();
  const swing = (markers: unknown[]): Clip => ({
    duration: 0.5,
    loop: false,
    tracks: [{ bone: "head", property: "rotate", keys: [[0, 0], [0.2, -10], [0.6, 40], [1, 40]], ease: "smooth" }],
    motions: [],
    visibility: [],
    markers: markers as Clip["markers"],
  });

  it("cleanMarkers: well-formed names, times clamped into 0..1, in order, no duplicates, at most 16", () => {
    expect(cleanMarkers([{ t: 0.9, name: "b" }, { t: -1, name: "a" }, { t: 2, name: "c" }, { t: "0.5", name: "d" }, { t: 0.5, name: "Not An Id" }, { t: NaN, name: "e" }, null, { t: 0.9, name: "b" }])).toEqual([
      { t: 0, name: "a" },
      { t: 0.5, name: "d" },
      { t: 0.9, name: "b" },
      { t: 1, name: "c" },
    ]);
    expect(cleanMarkers("nope")).toEqual([]);
    expect(cleanMarkers(Array.from({ length: 30 }, (_, i) => ({ t: i / 30, name: `m${i}` })))).toHaveLength(16);
  });

  it("settleMarkers moves impact-like markers to where the motion lands and leaves the rest", () => {
    const stops = motionStops(rig, swing([]));
    expect(stops.length).toBeGreaterThan(0);
    expect(stops[0]!).toBeGreaterThan(0.5);
    expect(stops[0]!).toBeLessThan(0.7);
    const settled = settleMarkers(rig, swing([{ t: 0.1, name: "impact" }, { t: 0.3, name: "glint" }]));
    expect(settled.markers).toEqual([
      { t: 0.3, name: "glint" },
      { t: stops[0]!, name: "impact" },
    ]);
    // A clip that doesn't move keeps the model's times.
    const still = { ...swing([{ t: 0.2, name: "strike" }]), tracks: [] };
    expect(settleMarkers(rig, still).markers).toEqual([{ t: 0.2, name: "strike" }]);
  });

  it("settleObjectClips plays clips as the game does and adds a marker the game listens for to the one clip that plays once", () => {
    const { clips, added } = settleObjectClips(rig, { idle: { ...swing([]), loop: false }, snap: { ...swing([]), loop: true } }, new Map([["idle", true], ["snap", false]]), ["strike"]);
    expect(clips.idle!.loop).toBe(true);
    expect(clips.snap!.loop).toBe(false);
    expect(added).toEqual(["strike on snap"]);
    expect(clips.snap!.markers).toEqual([{ t: motionStops(rig, clips.snap!)[0]!, name: "strike" }]);
  });

  it("how each object clip plays and which markers the game listens for, from the project", () => {
    const p = fixtureAnimatedProject();
    expect(Object.fromEntries(objectClipModes(p, "bolt"))).toEqual({ burst: false, charge: true, fly: true, idle: true });
    expect(Object.fromEntries(objectClipModes(p, "trap"))).toEqual({ snap: false, idle: true });
    expect(Object.fromEntries(objectClipModes(p, "shockwave"))).toEqual({ burst: false, idle: true });
    expect(heardMarkers(p, "trap")).toEqual(["strike"]);
    expect(heardMarkers(p, "lever")).toEqual(["click"]);
    expect(heardMarkers(p, "bolt")).toEqual([]);
  });
});
