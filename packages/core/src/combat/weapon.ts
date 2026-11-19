import { z } from "zod";
import { Color, Id } from "../common.ts";
import { FileRef } from "../art/fileRef.ts";
import { ControlAction, type ControlActionId } from "../controls/controls.ts";
import { ProjectileLook } from "../art/animation.ts";

/**
 * Weapons: generic attack data the player (and any enemy) can wield. A weapon is a list of
 * attacks plus its art; nothing here names a kind of weapon. An attack is picked by how it is
 * triggered (aim, ground or air, tap or hold, or as the next step of a combo), hits with one
 * shape (an arc, a box, a thrust or projectiles), runs windup -> active -> recovery, and can move
 * its wielder (lunge, recoil, pogo) and spend an item as ammo.
 *
 * The creator decides the loadout: `weapons.loadout.slots` binds weapons to control actions
 * (attack, alt_attack, special_attack), with an optional cycle action. A slot bound to `attack`
 * with no weapon in it keeps the built-in attack (the player's stats: reach, damage, cooldown),
 * so projects without weapons play exactly as before.
 *
 * Coordinates are px in the wielder's space, facing right (x forward, y down); angles are degrees
 * from straight ahead, negative up. The runtime mirrors them when facing left.
 */

export const MAX_WEAPONS = 64;
export const MAX_ATTACKS_PER_WEAPON = 12;
export const MAX_LOADOUT_SLOTS = 3;

const Px = z.number().min(0).max(2000);
const Seconds = z.number().min(0).max(10);
const Degrees = z.number().min(-180).max(180);

/** Projectiles an attack fires (the same knobs as an enemy's shoot action). */
export const WeaponProjectile = z.strictObject({
  speed: z.number().min(0).max(3000).default(700).describe("px/s at launch."),
  gravity: z.number().min(0).max(4000).default(0).describe("px/s² pulling it down (0 = straight line)."),
  count: z.number().int().min(1).max(8).default(1),
  spread: z.number().min(0).max(180).default(0).describe("Degrees between the first and last of a fan."),
  lifetime: z.number().min(0.05).max(10).default(1.2).describe("Seconds before it fades."),
  pierce: z.number().int().min(0).max(20).default(0).describe("Enemies it passes through before it breaks (it always breaks on solids)."),
  size: z.number().min(2).max(200).default(12).describe("Hit radius, px."),
  color: Color.default("#ffffff").describe("Drawn in this colour when it has no sprite."),
  sprite: FileRef.nullable().default(null).describe("Its image (pointing right), else a coloured shape."),
  look: ProjectileLook.prefault({}),
});
export type WeaponProjectile = z.infer<typeof WeaponProjectile>;

/** What an attack hits. */
export const HitShape = z.discriminatedUnion("type", [
  z
    .strictObject({
      type: z.literal("arc"),
      radius: Px.describe("Reach from the wielder's centre, px."),
      from: Degrees.default(-60).describe("Start angle (negative = up)."),
      to: Degrees.default(60).describe("End angle; the sweep runs from -> to over the active window."),
    })
    .describe("A swing: everything within `radius` between the two angles."),
  z
    .strictObject({
      type: z.literal("box"),
      width: Px,
      height: Px,
      offset: z.tuple([z.number().min(-1000).max(1000), z.number().min(-1000).max(1000)]).default([0, 0]).describe("Box centre relative to the wielder's front at chest height, px."),
    })
    .describe("A rectangle in front of the wielder (a jab, a shield bash, a stomp)."),
  z
    .strictObject({
      type: z.literal("thrust"),
      length: Px,
      width: z.number().min(1).max(400).default(24),
    })
    .describe("A straight line along the aim direction (a stab, a lance)."),
  z.strictObject({ type: z.literal("projectile"), projectile: WeaponProjectile.prefault({}) }).describe("Fire projectiles along the aim direction."),
]);
export type HitShape = z.infer<typeof HitShape>;

export const WeaponAttack = z.strictObject({
  id: Id,
  name: z.string().min(1).max(60),
  trigger: z
    .strictObject({
      aim: z.enum(["forward", "up", "down", "any"]).default("forward").describe("The aim held when pressed (down only counts in the air)."),
      where: z.enum(["ground", "air", "both"]).default("both"),
      hold: z.number().min(0).max(5).default(0).describe("Seconds the button must be held first (0 = tap): a charged attack."),
    })
    .prefault({})
    .describe("When this attack is the one used. A combo's `next` attack is used instead while its window is open."),
  shape: HitShape,
  damage: z.number().int().min(0).max(999).default(1),
  knockback: z.number().min(0).max(3000).default(350).describe("px/s pushed away from the wielder."),
  timing: z
    .strictObject({
      windup: Seconds.default(0.05),
      active: Seconds.default(0.12).describe("The hit shape is live only now."),
      recovery: Seconds.default(0.15),
    })
    .prefault({}),
  cooldown: Seconds.default(0.2).describe("After recovery, before this attack can start again."),
  movement: z
    .strictObject({
      lunge: z.number().min(0).max(3000).default(0).describe("px/s forward during the active window."),
      recoil: z.number().min(0).max(3000).default(0).describe("px/s pushed back when it hits (or fires)."),
      pogo: z.boolean().default(false).describe("A hit while aiming down bounces the wielder up (the pogo bounce)."),
    })
    .prefault({}),
  combo: z
    .strictObject({ next: Id.nullable().default(null).describe("Attack used if pressed again within `window`."), window: Seconds.default(0.35) })
    .prefault({}),
  ammo: z
    .strictObject({ item: Id.describe("An item the player carries."), per: z.number().int().min(1).max(99).default(1) })
    .nullable()
    .default(null)
    .describe("Spend this many of an item per use; with too few the attack doesn't start."),
  hitStop: z.number().min(0).max(1).default(0.05).describe("Seconds the action freezes on a hit."),
  shake: z.number().min(0).max(32).default(0).describe("Camera shake on a hit, px."),
  clip: Id.nullable().default(null).describe("The wielder's animation to play for it (a clip name in its art; else the attack clip slots by phase)."),
});
export type WeaponAttack = z.infer<typeof WeaponAttack>;

export const WeaponArt = z.strictObject({
  sprite: FileRef.nullable().default(null).describe("The weapon held at rest, pointing right (transparent background)."),
  grip: z.tuple([z.number(), z.number()]).default([0, 0]).describe("Where the hand holds it, sprite px."),
  tip: z.tuple([z.number(), z.number()]).default([0, 0]).describe("Its far end (the trail follows it), sprite px."),
  scale: z.number().min(0.05).max(10).default(1).describe("Sprite px to game px."),
  brief: z.string().max(400).default("").describe("What it looks like (for drawing it)."),
  trail: z
    .strictObject({ color: Color.default("#ffffff"), width: z.number().min(0).max(64).default(10), seconds: z.number().min(0).max(1).default(0.12) })
    .prefault({})
    .describe("The trail drawn behind the tip during the active window (width 0 = none)."),
  spark: Color.default("#fff2b0").describe("Hit spark colour."),
});
export type WeaponArt = z.infer<typeof WeaponArt>;

export const Weapon = z.strictObject({
  id: Id,
  name: z.string().min(1).max(60),
  description: z.string().max(400).default(""),
  attacks: z.array(WeaponAttack).max(MAX_ATTACKS_PER_WEAPON).default([]).describe("A weapon with no attacks does nothing yet (the lint says so)."),
  art: WeaponArt.prefault({}),
});
export type Weapon = z.infer<typeof Weapon>;

/** A loadout slot: the weapon in it is used with the slot's control action. */
export const LoadoutSlot = z.strictObject({
  id: Id,
  label: z.string().min(1).max(40),
  action: ControlAction.describe("attack, alt_attack or special_attack."),
  start: Id.nullable().default(null).describe("The weapon in it at the start of a run (null = empty; an empty attack slot uses the built-in attack)."),
});
export type LoadoutSlot = z.infer<typeof LoadoutSlot>;

/** Control actions a loadout slot can use. */
export const WEAPON_ACTIONS: readonly ControlActionId[] = ["attack", "alt_attack", "special_attack"];

export const Weapons = z.strictObject({
  list: z.array(Weapon).max(MAX_WEAPONS).default([]),
  loadout: z
    .strictObject({
      slots: z.array(LoadoutSlot).max(MAX_LOADOUT_SLOTS).default([{ id: "main", label: "Main", action: "attack", start: null }]),
      cycle: z.boolean().default(false).describe("The weapon_cycle action swaps the main slot through the weapons the player has."),
    })
    .prefault({}),
});
export type Weapons = z.infer<typeof Weapons>;

/** Reference checks (part of ProjectSpec validation). `items` are the world's item ids. */
export function weaponIssues(weapons: Weapons, items: ReadonlySet<string>): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const ids = new Set<string>();
  weapons.list.forEach((w, i) => {
    if (ids.has(w.id)) issues.push({ path: ["weapons", "list", i, "id"], message: `duplicate weapon "${w.id}"` });
    ids.add(w.id);
    const attacks = new Set(w.attacks.map((a) => a.id));
    if (attacks.size !== w.attacks.length) issues.push({ path: ["weapons", "list", i, "attacks"], message: `weapon "${w.id}" has two attacks with the same id` });
    w.attacks.forEach((a, j) => {
      if (a.combo.next !== null && !attacks.has(a.combo.next)) {
        issues.push({ path: ["weapons", "list", i, "attacks", j, "combo", "next"], message: `attack "${a.id}" combos into unknown attack "${a.combo.next}"` });
      }
      if (a.ammo && !items.has(a.ammo.item)) issues.push({ path: ["weapons", "list", i, "attacks", j, "ammo", "item"], message: `attack "${a.id}" uses unknown item "${a.ammo.item}" as ammo` });
    });
  });
  const slotIds = new Set<string>();
  const actions = new Set<string>();
  weapons.loadout.slots.forEach((s, i) => {
    if (slotIds.has(s.id)) issues.push({ path: ["weapons", "loadout", "slots", i, "id"], message: `duplicate loadout slot "${s.id}"` });
    slotIds.add(s.id);
    if (!WEAPON_ACTIONS.includes(s.action)) issues.push({ path: ["weapons", "loadout", "slots", i, "action"], message: `a loadout slot uses ${WEAPON_ACTIONS.join(", ")}, not "${s.action}"` });
    if (actions.has(s.action)) issues.push({ path: ["weapons", "loadout", "slots", i, "action"], message: `two loadout slots use "${s.action}"` });
    actions.add(s.action);
    if (s.start !== null && !ids.has(s.start)) issues.push({ path: ["weapons", "loadout", "slots", i, "start"], message: `slot "${s.id}" starts with unknown weapon "${s.start}"` });
  });
  return issues;
}

/** The weapon a slot starts with, if any. */
export const startWeapon = (weapons: Weapons, slotId: string): Weapon | undefined => {
  const id = weapons.loadout.slots.find((s) => s.id === slotId)?.start;
  return id ? weapons.list.find((w) => w.id === id) : undefined;
};
