import { z } from "zod";
import { Id } from "../common.ts";
import type { OperationResult } from "../operations.ts";
import type { ProjectSpec } from "../schema.ts";
import { commit, fail, parse } from "../world/opHelpers.ts";
import { LoadoutSlot, MAX_LOADOUT_SLOTS, MAX_WEAPONS, Weapon, WeaponArt, WeaponAttack, type Weapons } from "./weapon.ts";

/** Weapon operations: the project's weapons, their attacks and art, and the creator's loadout. */

export const CreateWeaponInput = z.strictObject({
  id: Id.describe("New weapon id."),
  name: z.string().min(1).max(60),
  description: z.string().max(400).default(""),
  brief: z.string().max(400).default("").describe("What it looks like (for drawing it)."),
});
export const UpdateWeaponInput = z.strictObject({
  weaponId: Id,
  name: z.string().min(1).max(60).optional(),
  description: z.string().max(400).optional(),
  art: WeaponArt.partial().optional().describe("Fields of its art to change (the rest stay)."),
});
export const SetWeaponAttackInput = z.strictObject({
  weaponId: Id,
  attack: WeaponAttack.describe("Replaces the attack with the same id, or adds it."),
});
export const DeleteWeaponAttackInput = z.strictObject({ weaponId: Id, attackId: Id });
export const DeleteWeaponInput = z.strictObject({ weaponId: Id });
export const SetLoadoutInput = z.strictObject({
  slots: z.array(LoadoutSlot).max(MAX_LOADOUT_SLOTS).optional().describe("The loadout's slots, replacing them."),
  cycle: z.boolean().optional(),
});

const withWeapons = (project: ProjectSpec, weapons: Weapons): OperationResult => commit({ ...project, weapons });

function findWeapon(project: ProjectSpec, id: string): { ok: true; index: number; weapon: Weapon } | { ok: false; result: OperationResult } {
  const index = project.weapons.list.findIndex((w) => w.id === id);
  if (index < 0) {
    const known = project.weapons.list.map((w) => w.id).join(", ") || "none yet";
    return { ok: false, result: fail("not_found", `no weapon "${id}" (weapons: ${known})`) };
  }
  return { ok: true, index, weapon: project.weapons.list[index]! };
}

const replaceAt = <T>(list: readonly T[], index: number, item: T): T[] => list.map((x, i) => (i === index ? item : x));

/** Add a weapon. */
export function createWeapon(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(CreateWeaponInput, input, "createWeapon");
  if (!p.ok) return p;
  const { id, name, description, brief } = p.data;
  const weapon = Weapon.parse({ id, name, description, attacks: [], art: { brief } });
  if (project.weapons.list.some((w) => w.id === weapon.id)) return fail("invalid_input", `a weapon "${weapon.id}" already exists`);
  if (project.weapons.list.length >= MAX_WEAPONS) return fail("invalid_input", `a game has at most ${MAX_WEAPONS} weapons`);
  return withWeapons(project, { ...project.weapons, list: [...project.weapons.list, weapon] });
}

/** Rename or describe a weapon, or change fields of its art. */
export function updateWeapon(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(UpdateWeaponInput, input, "updateWeapon");
  if (!p.ok) return p;
  const found = findWeapon(project, p.data.weaponId);
  if (!found.ok) return found.result;
  const { name, description, art } = p.data;
  const weapon: Weapon = {
    ...found.weapon,
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(art ? { art: WeaponArt.parse({ ...found.weapon.art, ...art }) } : {}),
  };
  return withWeapons(project, { ...project.weapons, list: replaceAt(project.weapons.list, found.index, weapon) });
}

/** Add an attack to a weapon, or replace the one with the same id. */
export function setWeaponAttack(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(SetWeaponAttackInput, input, "setWeaponAttack");
  if (!p.ok) return p;
  const found = findWeapon(project, p.data.weaponId);
  if (!found.ok) return found.result;
  const { attack } = p.data;
  const at = found.weapon.attacks.findIndex((a) => a.id === attack.id);
  const attacks = at < 0 ? [...found.weapon.attacks, attack] : replaceAt(found.weapon.attacks, at, attack);
  const weapon = Weapon.safeParse({ ...found.weapon, attacks });
  if (!weapon.success) return fail("invalid_input", weapon.error.issues[0]?.message ?? "invalid weapon");
  return withWeapons(project, { ...project.weapons, list: replaceAt(project.weapons.list, found.index, weapon.data) });
}

/** Remove an attack (combos into it end there). */
export function deleteWeaponAttack(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(DeleteWeaponAttackInput, input, "deleteWeaponAttack");
  if (!p.ok) return p;
  const found = findWeapon(project, p.data.weaponId);
  if (!found.ok) return found.result;
  const { attackId } = p.data;
  if (!found.weapon.attacks.some((a) => a.id === attackId)) return fail("not_found", `weapon "${found.weapon.id}" has no attack "${attackId}"`);
  const attacks = found.weapon.attacks
    .filter((a) => a.id !== attackId)
    .map((a) => (a.combo.next === attackId ? { ...a, combo: { ...a.combo, next: null } } : a));
  return withWeapons(project, { ...project.weapons, list: replaceAt(project.weapons.list, found.index, { ...found.weapon, attacks }) });
}

/** Delete a weapon; loadout slots that started with it start empty. Enemies or handlers that use it are reported by the lint. */
export function deleteWeapon(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(DeleteWeaponInput, input, "deleteWeapon");
  if (!p.ok) return p;
  const found = findWeapon(project, p.data.weaponId);
  if (!found.ok) return found.result;
  const id = found.weapon.id;
  return withWeapons(project, {
    list: project.weapons.list.filter((w) => w.id !== id),
    loadout: { ...project.weapons.loadout, slots: project.weapons.loadout.slots.map((s) => (s.start === id ? { ...s, start: null } : s)) },
  });
}

/** Set the loadout: its slots (each bound to a control action, with the weapon it starts with) and whether the player can cycle weapons. */
export function setLoadout(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(SetLoadoutInput, input, "setLoadout");
  if (!p.ok) return p;
  const { slots, cycle } = p.data;
  return withWeapons(project, {
    ...project.weapons,
    loadout: { slots: slots ?? project.weapons.loadout.slots, cycle: cycle ?? project.weapons.loadout.cycle },
  });
}

export const weaponOperations = { createWeapon, updateWeapon, setWeaponAttack, deleteWeaponAttack, deleteWeapon, setLoadout };
export const WEAPON_OPERATION_NAMES = Object.keys(weaponOperations) as (keyof typeof weaponOperations)[];
