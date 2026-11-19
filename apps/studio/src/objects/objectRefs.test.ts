import { describe, expect, it } from "vitest";
import { fixtureAnimatedProject, type CharacterAsset } from "@anomaly/core";
import { clipChoices, clipsOf, markerChoices, newObjectCall, objectIds, propArtFrom, propArtValue, targetAsset, type HandlerPlace } from "./objectRefs.ts";
import { characterSubject, findObjectSubject, isSubjectJob, missingClips, subjectRef, subjectStage } from "../characters/subject.ts";

const project = fixtureAnimatedProject();
const arena = project.world.rooms.find((r) => r.id === "arena")!;
const onProp = (id: string): HandlerPlace => ({ room: arena, self: { kind: "prop", id } });
const onSpawn = (id: string): HandlerPlace => ({ room: arena, self: { kind: "spawn", id } });
const inRoom: HandlerPlace = { room: arena, self: null };

describe("animation pickers", () => {
  it("list objects and make a fresh object id from a name", () => {
    expect(objectIds(project)).toEqual(["lever", "trap", "shockwave", "bolt"]);
    expect(newObjectCall(project, "Lever", " a second lever ")).toEqual({ name: "createObject", input: { id: "lever_2", name: "Lever", brief: "a second lever" } });
    expect(newObjectCall(project, "Floor Spikes!", "").input.id).toBe("floor_spikes");
  });

  it("find the art a playAnimation target plays from", () => {
    expect(targetAsset(project, { kind: "self" }, onProp("trap"))).toBe("trap");
    expect(targetAsset(project, undefined, onSpawn("charger_1"))).toBe("charger_look");
    expect(targetAsset(project, { kind: "prop", prop: "lever" }, inRoom)).toBe("lever");
    expect(targetAsset(project, { kind: "prop", prop: "door" }, inRoom)).toBeUndefined();
    expect(targetAsset(project, { kind: "self" }, inRoom)).toBeUndefined();
  });

  it("offer the clips of the effect's art, or free text when it has none", () => {
    expect(clipChoices(project, { type: "playAnimation", target: { kind: "self" } }, onProp("lever"))).toEqual(["idle", "pull"]);
    expect(clipChoices(project, { type: "playAnimation", target: { kind: "spawn", spawn: "charger_1" } }, inRoom)).toEqual(["idle", "attack"]);
    expect(clipChoices(project, { type: "spawnEffect", object: "bolt" }, inRoom)).toEqual(["idle", "charge", "fly", "burst"]);
    expect(clipChoices(project, { type: "playAnimation", target: { kind: "player" } }, inRoom)).toBeNull();
    expect(clipsOf(project, "nope")).toEqual([]);
  });

  it("offer marker names: a prop's or spawn's own, else every one", () => {
    expect(markerChoices(project, { type: "marker" }, onProp("trap"))).toEqual(["strike"]);
    expect(markerChoices(project, { type: "marker" }, onSpawn("charger_1"))).toEqual(["impact"]);
    expect(markerChoices(project, { type: "marker" }, inRoom)).toEqual(["click", "strike", "impact"]);
    expect(markerChoices(project, { type: "marker", from: { kind: "prop", prop: "lever" } }, inRoom)).toEqual(["click"]);
    expect(markerChoices(project, { type: "marker" }, onProp("door"))).toBeNull();
  });

  it("switch a prop's art between colour, kit piece and object", () => {
    expect(propArtValue(null)).toBe("");
    expect(propArtValue({ biome: "caves", piece: "rock" })).toBe("kit:caves/rock");
    expect(propArtValue({ object: "lever", idle: "idle", scale: 1 })).toBe("object:lever");
    expect(propArtFrom(project, "kit:caves/rock", null)).toEqual({ biome: "caves", piece: "rock" });
    expect(propArtFrom(project, "object:trap", { object: "lever", idle: "pull", scale: 2 })).toEqual({ object: "trap", idle: "idle", scale: 2 });
    expect(propArtFrom(project, "", { object: "lever", idle: "idle", scale: 1 })).toBeNull();
  });
});

describe("the workbench's subject", () => {
  it("is a character or an object: art jobs name it by characterId or objectId, the stage by mode", () => {
    const lever = findObjectSubject(project, "lever")!;
    expect(lever).toMatchObject({ kind: "object", id: "lever", name: "Lever" });
    expect(findObjectSubject(project, "charger_look")).toBeNull();
    expect(subjectRef(lever)).toEqual({ objectId: "lever" });
    const charger = characterSubject(project, project.characters.find((c) => c.id === "charger")!);
    expect(subjectRef(charger)).toEqual({ characterId: "charger" });
    expect(charger.asset?.id).toBe("charger_look");
    expect(isSubjectJob({ objectId: "lever" }, lever)).toBe(true);
    expect(isSubjectJob({ characterId: "lever" }, lever)).toBe(false);
    const view = { clip: "pull", time: null, speed: 1, flip: true, bones: false, onion: { image: null, alpha: 0 } };
    expect(subjectStage(lever, view)).toEqual({ mode: "object", assetId: "lever", clip: "pull", time: null, speed: 1, bones: false, onion: { image: null, alpha: 0 } });
    expect(subjectStage(charger, view)).toEqual({ mode: "character", characterId: "charger", ...view });
  });

  it("lists the clips the game asks of an object that it lacks", () => {
    const trap = findObjectSubject(project, "trap")!;
    expect(missingClips(project, trap)).toEqual([]);
    const { snap: _snap, ...clips } = (trap.asset as CharacterAsset).clips;
    expect(missingClips(project, { ...trap, asset: { ...trap.asset!, clips } })).toEqual(["snap"]);
  });
});
