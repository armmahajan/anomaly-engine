import { describe, expect, it } from "vitest";
import { createDefaultProject, defaultArtDirection, drawnEmptyHanded, exampleRig, type Character } from "@anomaly/core";
import { animPrompt, conceptPrompt, cutoutSystemPrompt, EMPTY_HANDS, flatRedrawPrompt, pickPrompt, rigSystemPrompt } from "../src/prompts.ts";

const project = createDefaultProject();
const player = project.characters.find((c) => c.kind === "player")!;
const charger = project.characters.find((c) => c.id === "charger")! as Extract<Character, { kind: "enemy" }>;
const wielder: Character = { ...charger, behavior: { initial: "swing", states: { swing: { action: { type: "useWeapon", weapon: "blade", attack: null, aim: "facing" }, transitions: [] } }, interrupts: [] } };

describe("characters and the weapon system", () => {
  it("the player and enemies that attack with weapons are drawn empty-handed; other enemies may hold things as part of their body", () => {
    expect(drawnEmptyHanded(project, player)).toBe(true);
    expect(drawnEmptyHanded(project, wielder)).toBe(true);
    expect(drawnEmptyHanded(project, charger)).toBe(false);
  });

  it("their designs, picks, redraws, rigs and clips leave the weapon to the weapon system", () => {
    const brief = "a sword-wielding fighter";
    const concept = (character: Character, emptyHanded: boolean) => conceptPrompt({ character, brief, direction: defaultArtDirection(), refining: false, rigReady: true, emptyHanded });
    expect(concept(player, true)).toContain(EMPTY_HANDS);
    expect(concept(charger, false)).not.toContain(EMPTY_HANDS);
    expect(pickPrompt(brief, defaultArtDirection(), undefined, undefined, true)).toMatch(/hands are empty/);
    expect(flatRedrawPrompt(brief, true)).toContain(EMPTY_HANDS);
    expect(rigSystemPrompt(defaultArtDirection(), { width: 512, height: 512 })).toMatch(/Leave out weapons/);
    expect(cutoutSystemPrompt({ width: 512, height: 512 })).not.toMatch(/antennae, a weapon/);
    const anim = animPrompt({ character: player, brief, rig: exampleRig(), slots: ["idle", "attack"], emptyHanded: true });
    expect(anim).toMatch(/weapons are separate sprites/);
  });
});
