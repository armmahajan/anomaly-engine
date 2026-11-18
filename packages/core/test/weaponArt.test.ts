import { describe, expect, it } from "vitest";
import { applyOperation, ArtJobRequest, attackClipName, planGameExport, runtimeImageRefs, wantedWeaponClips, Weapon, type ProjectSpec } from "../src/index.ts";
import { artfulGame } from "./fixtures/exportGame.ts";

// Weapon art in the core: the images the runtime is sent for weapons, the art operation keeping
// what it is not given, and the attack clips a wielder's art needs.

const SPRITE = `${"a".repeat(32)}.png`;
const BOLT = `${"b".repeat(32)}.png`;

function armed(): ProjectSpec {
  const game = artfulGame();
  const weapon = Weapon.parse({
    id: "launcher",
    name: "Launcher",
    attacks: [
      { id: "jab", name: "Jab", shape: { type: "thrust", length: 60 } },
      { id: "fire", name: "Fire", shape: { type: "projectile", projectile: { sprite: BOLT } }, clip: "launcher_shot" },
    ],
    art: { sprite: SPRITE, grip: [10, 12], tip: [90, 12], brief: "a long tube" },
  });
  return { ...game, weapons: { ...game.weapons, list: [weapon], loadout: { slots: [{ id: "main", label: "Main", action: "attack", start: "launcher" }], cycle: false } } };
}

describe("weapon art in the core", () => {
  it("sends and exports weapon and projectile sprites", () => {
    const project = armed();
    expect(runtimeImageRefs(project)).toEqual(expect.arrayContaining([SPRITE, BOLT]));
    const plan = planGameExport(project);
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.data.images).toEqual(expect.arrayContaining([SPRITE, BOLT]));
    expect(runtimeImageRefs(plan.data.project)).toEqual(plan.data.images);
  });

  it("updateWeapon changes only the art fields it is given", () => {
    const result = applyOperation(armed(), "updateWeapon", { weaponId: "launcher", art: { grip: [12, 14] } });
    if (!result.ok) throw new Error(result.error.message);
    const art = result.project.weapons.list[0]!.art;
    expect(art).toMatchObject({ sprite: SPRITE, grip: [12, 14], tip: [90, 12], brief: "a long tube" });
  });

  it("art job requests: weaponArt needs a weapon, animate takes one clip by name with a direction", () => {
    expect(ArtJobRequest.safeParse({ stage: "weaponArt", weaponId: "launcher" }).success).toBe(true);
    expect(ArtJobRequest.safeParse({ stage: "weaponArt" }).success).toBe(false);
    expect(ArtJobRequest.safeParse({ stage: "animate", characterId: "player", clip: "taunt", direction: "a cocky shrug" }).success).toBe(true);
    expect(ArtJobRequest.safeParse({ stage: "animate", characterId: "player", clip: "Not An Id" }).success).toBe(false);
  });

  it("a wielder's art needs one clip per attack: the attack's clip, else <weapon>_<attack>", () => {
    const project = armed();
    const weapon = project.weapons.list[0]!;
    expect(weapon.attacks.map((a) => attackClipName(weapon, a))).toEqual(["launcher_jab", "launcher_shot"]);
    const player = project.characters.find((c) => c.kind === "player")!;
    expect(player.appearance).toBeTruthy();
    expect(wantedWeaponClips(project, player.appearance!).map((c) => c.clip)).toEqual(["launcher_jab", "launcher_shot"]);
  });
});
