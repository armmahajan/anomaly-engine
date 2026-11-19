import { describe, expect, it } from "vitest";
import { createDefaultProject, lintProject, lintWeapons, MAX_HITS, ProjectSpec } from "../src/index.ts";

// The weapon lints (combat/weaponLint.ts): one project per mistake, each caught by its code, and
// well-made weapons left alone.

const base = createDefaultProject();
const sword = { id: "sword", name: "Sword", attacks: [{ id: "cut", name: "Cut", shape: { type: "arc", radius: 70 } }] };

/** The default project with these weapons, the attack slot starting with `start`, and world fields merged in. */
function project(weapons: object[], start: string | null = null, world: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): ProjectSpec {
  return ProjectSpec.parse({ ...base, ...extra, weapons: { list: weapons, loadout: { slots: [{ id: "main", label: "Main", action: "attack", start }] } }, world: { ...base.world, ...world } });
}
const codes = (p: ProjectSpec) => lintWeapons(p).map((w) => w.code);
const withAttack = (attack: object) => ({ ...sword, attacks: [{ id: "cut", name: "Cut", shape: { type: "arc", radius: 70 }, ...attack }] });

describe("lintWeapons", () => {
  it("leaves projects without weapons, and well-made weapons, alone (and runs with every lint)", () => {
    expect(lintWeapons(base)).toEqual([]);
    expect(lintWeapons(project([sword], "sword"))).toEqual([]);
    expect(lintProject(project([{ ...sword, attacks: [] }])).map((w) => w.code)).toContain("weapon_no_attacks");
  });

  it("a weapon with no attacks", () => {
    expect(codes(project([{ ...sword, attacks: [] }]))).toEqual(["weapon_no_attacks"]);
  });

  it("an attack that can't reach the smallest enemy (one that stays inside the player, or swings over its head)", () => {
    expect(codes(project([withAttack({ shape: { type: "arc", radius: 10 } })], "sword"))).toEqual(["weapon_out_of_reach"]);
    expect(codes(project([withAttack({ shape: { type: "box", width: 40, height: 10, offset: [10, -40] } })], "sword"))).toEqual(["weapon_out_of_reach"]);
    // Not held by the player: not the player's problem.
    expect(codes(project([withAttack({ shape: { type: "arc", radius: 10 } })]))).toEqual([]);
  });

  it("projectiles that fade before they leave the player", () => {
    expect(codes(project([withAttack({ shape: { type: "projectile", projectile: { speed: 60, lifetime: 0.1 } } })], "sword"))).toEqual(["projectile_short_lived"]);
    expect(codes(project([withAttack({ shape: { type: "projectile", projectile: { speed: 600, lifetime: 0.5 } } })], "sword"))).toEqual([]);
  });

  it("ammo nothing gives", () => {
    const items = [{ id: "bolt", name: "Bolt" }];
    const shooter = withAttack({ ammo: { item: "bolt" } });
    expect(codes(project([shooter], "sword", { items }))).toEqual(["ammo_no_supply"]);
    expect(codes(project([shooter], "sword", { items, handlers: [{ on: { type: "gameStarted" }, do: [{ type: "giveItem", item: "bolt", count: 5 }] }] }))).toEqual([]);
  });

  it("damage that one-shots an enemy the game waits on, or needs more than MAX_HITS hits", () => {
    const rooms = base.world.rooms.map((r, i) => (i === 0 ? { ...r, spawns: r.spawns.map((s) => (s.characterId === "charger" ? { ...s, healthBar: { title: "Charger" } } : s)) } : r));
    expect(codes(project([withAttack({ damage: 4 })], "sword", { rooms }))).toEqual(["weapon_one_shot"]);
    expect(codes(project([withAttack({ damage: 4 })], "sword"))).toEqual([]); // nothing waits on that fight
    const tough = { characters: base.characters.map((c) => (c.id === "crawler" && c.kind === "enemy" ? { ...c, stats: { ...c.stats, health: MAX_HITS + 1 } } : c)) };
    expect(codes(project([sword], "sword", {}, tough))).toEqual(["weapon_too_weak"]);
  });

  it("giveWeapon, takeWeapon, conditions and useWeapon naming a weapon that doesn't exist", () => {
    const handlers = [
      { on: { type: "gameStarted" }, do: [{ type: "giveWeapon", weapon: "ghost" }, { type: "takeWeapon", weapon: "ghost" }] },
      { on: { type: "roomEntered" }, when: [{ type: "weapon", weapon: "ghost" }], do: [{ type: "setFlag", flag: "x" }] },
    ];
    expect(codes(project([sword], "sword", { handlers }))).toEqual(["weapon_unknown", "weapon_unknown", "weapon_unknown"]);
    const characters = base.characters.map((c) =>
      c.id === "crawler" && c.kind === "enemy" ? { ...c, behavior: { initial: "go", states: { go: { action: { type: "useWeapon", weapon: "ghost" }, transitions: [] } }, interrupts: [] } } : c,
    );
    expect(codes(project([sword], "sword", {}, { characters }))).toEqual(["weapon_unknown"]);
  });

  it("an enemy's weapon attack without the warning every enemy attack gets", () => {
    const characters = base.characters.map((c) =>
      c.id === "crawler" && c.kind === "enemy" ? { ...c, behavior: { initial: "go", states: { go: { action: { type: "useWeapon", weapon: "sword" }, transitions: [] } }, interrupts: [] } } : c,
    );
    expect(codes(project([withAttack({ timing: { windup: 0.05 } })], null, {}, { characters }))).toEqual(["unwarned_attack"]);
    expect(codes(project([withAttack({ timing: { windup: 0.3 } })], null, {}, { characters }))).toEqual([]);
  });

  it("a loadout slot on an action with no keys", () => {
    const p = project([sword], "sword");
    const unbound = { ...p, controls: { ...p.controls, bindings: { ...p.controls.bindings, attack: [] } } } as ProjectSpec;
    expect(codes(unbound)).toEqual(["loadout_no_keys"]);
  });
});
