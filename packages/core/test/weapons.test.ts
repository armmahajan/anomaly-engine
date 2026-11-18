import { describe, expect, it } from "vitest";
import { applyOperation, createDefaultProject, ProjectSpec, Weapon, type OperationResult } from "../src/index.ts";

const ok = (r: OperationResult) => {
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};

const blade = () =>
  Weapon.parse({
    id: "blade",
    name: "Blade",
    attacks: [
      { id: "cut", name: "Cut", shape: { type: "arc", radius: 70 }, combo: { next: "cut2" } },
      { id: "cut2", name: "Second cut", shape: { type: "arc", radius: 80, from: 60, to: -60 } },
      { id: "up", name: "Rising cut", trigger: { aim: "up" }, shape: { type: "thrust", length: 90 } },
    ],
  });

/** The blade, made the way the tools do: createWeapon, then one setWeaponAttack per attack. */
function withBlade(project: ProjectSpec): OperationResult {
  const w = blade();
  let r = applyOperation(project, "createWeapon", { id: w.id, name: w.name });
  for (const attack of [...w.attacks].reverse()) if (r.ok) r = applyOperation(r.project, "setWeaponAttack", { weaponId: w.id, attack });
  return r;
}

describe("weapons (contracts)", () => {
  it("older projects and new ones have none: one main slot on attack, empty (the built-in attack)", () => {
    const project = createDefaultProject();
    expect(project.weapons.list).toEqual([]);
    expect(project.weapons.loadout).toEqual({ slots: [{ id: "main", label: "Main", action: "attack", start: null }], cycle: false });
    const { weapons: _, ...older } = project;
    expect(ProjectSpec.parse(older).weapons).toEqual(project.weapons);
  });

  it("are created, edited and deleted as undoable operations, with references checked", () => {
    let p = ok(withBlade(createDefaultProject()));
    expect(applyOperation(p, "createWeapon", { id: "blade", name: "Again" }).ok).toBe(false); // same id
    p = ok(applyOperation(p, "setLoadout", { slots: [{ id: "main", label: "Main", action: "attack", start: "blade" }, { id: "alt", label: "Alt", action: "alt_attack" }], cycle: true }));
    expect(p.weapons.loadout.slots.map((s) => s.start)).toEqual(["blade", null]);
    // Two slots on one action, an unknown start weapon: refused.
    expect(applyOperation(p, "setLoadout", { slots: [{ id: "a", label: "A", action: "attack" }, { id: "b", label: "B", action: "attack" }] }).ok).toBe(false);
    expect(applyOperation(p, "setLoadout", { slots: [{ id: "a", label: "A", action: "attack", start: "nope" }] }).ok).toBe(false);
    expect(applyOperation(p, "setLoadout", { slots: [{ id: "a", label: "A", action: "jump" }] }).ok).toBe(false);

    // Ammo must be a known item; a combo must point at a known attack.
    expect(applyOperation(p, "setWeaponAttack", { weaponId: "blade", attack: { id: "shot", name: "Shot", shape: { type: "projectile" }, ammo: { item: "arrows" } } }).ok).toBe(false);
    p = ok(applyOperation(p, "setWeaponAttack", { weaponId: "blade", attack: { id: "shot", name: "Shot", shape: { type: "projectile", projectile: { count: 3, spread: 20 } } } }));
    expect(p.weapons.list[0]!.attacks.map((a) => a.id)).toEqual(["up", "cut2", "cut", "shot"]); // a combo's next attack is added first

    // Deleting an attack ends combos into it; the last attack can't go.
    p = ok(applyOperation(p, "deleteWeaponAttack", { weaponId: "blade", attackId: "cut2" }));
    expect(p.weapons.list[0]!.attacks.find((a) => a.id === "cut")!.combo.next).toBeNull();

    p = ok(applyOperation(p, "updateWeapon", { weaponId: "blade", name: "Old blade", art: { trail: { color: "#ffcc00", width: 8, seconds: 0.1 } } }));
    expect(p.weapons.list[0]!.name).toBe("Old blade");
    expect(p.weapons.list[0]!.art.spark).toBe("#fff2b0"); // untouched art fields stay

    // Deleting the weapon empties the slot that started with it.
    p = ok(applyOperation(p, "deleteWeapon", { weaponId: "blade" }));
    expect(p.weapons.list).toEqual([]);
    expect(p.weapons.loadout.slots[0]!.start).toBeNull();
  });

  it("can be given, taken and checked by handlers, and used by an enemy behavior", () => {
    const p = ok(withBlade(createDefaultProject()));
    expect(
      applyOperation(p, "addHandler", {
        handler: { on: { type: "gameStarted" }, when: [{ type: "not", of: { type: "weapon", weapon: "blade" } }], do: [{ type: "giveWeapon", weapon: "blade" }] },
      }).ok,
    ).toBe(true);
    const charger = p.characters.find((c) => c.id === "charger")!;
    if (charger.kind !== "enemy") throw new Error("charger is an enemy");
    const behavior = { initial: "swing", states: { swing: { action: { type: "useWeapon", weapon: "blade" }, transitions: [] } }, interrupts: [] };
    expect(applyOperation(p, "setBehavior", { characterId: "charger", behavior }).ok).toBe(true);
  });

  it("rigs may say where weapons are held", () => {
    const p = createDefaultProject();
    expect(applyOperation(p, "moveBonePivot", { assetId: "x", bone: "y", pivot: [0, 0] }).ok).toBe(false); // no such asset
  });
});
