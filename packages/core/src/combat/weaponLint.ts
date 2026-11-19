import { MIN_WARNING } from "../behavior.ts";
import type { EnemyCharacter, ProjectSpec } from "../schema.ts";
import { allConditions, allHandlers, type DomainWarning } from "../events/lint.ts";
import type { Effect } from "../events/events.ts";
import type { Weapon, WeaponAttack } from "./weapon.ts";
import { AIM_VECTORS, attackHits, fanHeadings, projectilePath, triggerAims, type BodySize, type HitBox, type XY } from "./weaponModel.ts";

/**
 * Likely mistakes with weapons (the mechanics are combat/weaponModel.ts and the runtime's
 * weapon_runner.gd): attacks that can't reach an enemy (or, an enemy's, the player), damage that
 * ends a fight the game waits on in one hit or drags any fight past MAX_HITS hits, projectiles
 * that die inside their wielder, ammo nothing gives, weapons with no attacks, references to
 * weapons that don't exist, loadout slots on actions with no keys, and enemy weapon attacks
 * without the warning every enemy attack gets (MIN_WARNING).
 */

/** More hits than this to beat an enemy is a slog. */
export const MAX_HITS = 40;

const AIMS = ["forward", "up", "down"] as const;

/** The strip a target of `size` standing in the aim direction, touching the wielder or farther, occupies (wielder space, centre origin). */
function lane(aim: (typeof AIMS)[number], body: BodySize, size: BodySize): HitBox {
  const far = 1e5;
  const hw = body.width / 2;
  const hh = body.height / 2;
  switch (aim) {
    case "forward":
      return [hw, hh - size.height, far, hh]; // on the same ground, ahead
    case "up":
      return [-size.width / 2, -far, size.width / 2, -hh];
    case "down":
      return [-size.width / 2, hh, size.width / 2, far];
  }
}

/** Can the attack hit a target of `size` anywhere ahead of the wielder in one of the aims it is used with? */
function reachesTarget(attack: WeaponAttack, body: BodySize, size: BodySize): boolean {
  const aims = AIMS.filter((name) => [...triggerAims(attack, "ground"), ...triggerAims(attack, "air")].some((v) => v === AIM_VECTORS[name]));
  return aims.some((name) => attackHits(attack, AIM_VECTORS[name], body, lane(name, body, size)));
}

/** Weapons the player can hold: the loadout's starts and every giveWeapon (handlers and modal buttons). */
export function heldWeaponIds(project: ProjectSpec): Set<string> {
  const effects = [...allHandlers(project).flatMap(({ handlers }) => handlers.flatMap((h) => h.do)), ...project.world.modals.flatMap((m) => m.buttons.flatMap((b) => b.do))];
  return new Set([...project.weapons.loadout.slots.flatMap((s) => (s.start ? [s.start] : [])), ...effects.flatMap((e) => (e.type === "giveWeapon" ? [e.weapon] : []))]);
}

/**
 * The most health an enemy may have before the lint calls a weapon the player holds too weak
 * (weapon_too_weak): MAX_HITS hits of the weakest held weapon's strongest attack. Null when the
 * player holds no weapon that does damage.
 */
export function weaponHealthCap(project: ProjectSpec): number | null {
  const held = heldWeaponIds(project);
  const bests = project.weapons.list.filter((w) => held.has(w.id) && w.attacks.length > 0).map((w) => Math.max(...w.attacks.map((a) => a.damage)));
  const usable = bests.filter((b) => b > 0);
  return usable.length ? MAX_HITS * Math.min(...usable) : null;
}

export function lintWeapons(project: ProjectSpec): DomainWarning[] {
  const warnings: DomainWarning[] = [];
  const weapons = new Map(project.weapons.list.map((w) => [w.id, w]));
  const player = project.characters.find((c) => c.kind === "player");
  const enemies = project.characters.filter((c): c is EnemyCharacter => c.kind === "enemy");
  const handlers = allHandlers(project);
  const effects: { path: string; effect: Effect }[] = [
    ...handlers.flatMap(({ path, handlers: list }) => list.flatMap((h, i) => h.do.map((effect, j) => ({ path: `${path}.${i}.do.${j}`, effect })))),
    ...project.world.modals.flatMap((m, i) => m.buttons.flatMap((b, j) => b.do.map((effect, k) => ({ path: `world.modals.${i}.buttons.${j}.do.${k}`, effect })))),
  ];
  const given = new Set(effects.flatMap(({ effect: e }) => (e.type === "giveItem" ? [e.item] : [])));
  const name = (w: Weapon) => `weapon "${w.id}"`;

  // References.
  for (const { path, effect: e } of effects) {
    if ((e.type === "giveWeapon" || e.type === "takeWeapon") && !weapons.has(e.weapon)) {
      warnings.push({ code: "weapon_unknown", path, message: `${e.type} names weapon "${e.weapon}", which doesn't exist` });
    }
    if (e.type === "giveWeapon" && e.slot !== null && !project.weapons.loadout.slots.some((s) => s.id === e.slot)) {
      warnings.push({ code: "weapon_unknown_slot", path, message: `giveWeapon puts "${e.weapon}" in slot "${e.slot}", which the loadout doesn't have` });
    }
  }
  for (const { path, condition: c } of allConditions(project)) {
    if (c.type === "weapon" && !weapons.has(c.weapon)) warnings.push({ code: "weapon_unknown", path, message: `a condition checks weapon "${c.weapon}", which doesn't exist` });
  }
  project.characters.forEach((c, i) => {
    if (c.kind !== "enemy") return;
    for (const [id, state] of Object.entries(c.behavior.states)) {
      const a = state.action;
      if (a.type !== "useWeapon") continue;
      const path = `characters.${i}.behavior.states.${id}.action`;
      const w = weapons.get(a.weapon);
      if (!w) {
        warnings.push({ code: "weapon_unknown", path, message: `"${c.id}" state "${id}" uses weapon "${a.weapon}", which doesn't exist` });
        continue;
      }
      const attack = a.attack === null ? w.attacks[0] : w.attacks.find((x) => x.id === a.attack);
      if (!attack) {
        warnings.push({ code: "weapon_unknown", path, message: a.attack === null ? `"${c.id}" state "${id}" uses ${name(w)}, which has no attacks` : `"${c.id}" state "${id}" uses attack "${a.attack}", which ${name(w)} doesn't have` });
        continue;
      }
      if (attack.timing.windup < MIN_WARNING) {
        warnings.push({ code: "unwarned_attack", path, message: `"${c.id}" state "${id}" attacks with "${attack.id}" of ${name(w)}, whose windup is ${attack.timing.windup} s: give it at least ${MIN_WARNING} s so the player sees it coming` });
      }
      if (player && !reachesTarget(attack, c.size, player.size)) {
        warnings.push({ code: "weapon_out_of_reach", path, message: `"${c.id}" state "${id}" attacks with "${attack.id}" of ${name(w)}, which can't reach the player from "${c.id}"` });
      }
    }
  });

  // The loadout.
  project.weapons.loadout.slots.forEach((slot, i) => {
    const keys = (project.controls.bindings as Partial<Record<string, readonly string[]>>)[slot.action] ?? [];
    if (keys.length === 0) warnings.push({ code: "loadout_no_keys", path: `weapons.loadout.slots.${i}.action`, message: `slot "${slot.id}" uses ${slot.action}, which has no keys (Game > Controls)` });
  });

  // Weapons the player can hold: the loadout's starts and every giveWeapon.
  const held = heldWeaponIds(project);
  const smallest = enemies.reduce<EnemyCharacter | null>((best, e) => (best === null || e.size.width * e.size.height < best.size.width * best.size.height ? e : best), null);
  const spawned = new Set(project.world.rooms.flatMap((r) => r.spawns.map((s) => s.characterId)));
  const waitedOn = foughtFor(project);

  project.weapons.list.forEach((w, i) => {
    const at = `weapons.list.${i}`;
    if (w.attacks.length === 0) {
      warnings.push({ code: "weapon_no_attacks", path: at, message: `${name(w)} has no attacks: it does nothing` });
      return;
    }
    w.attacks.forEach((attack, j) => {
      const path = `${at}.attacks.${j}`;
      if (attack.ammo && !given.has(attack.ammo.item)) {
        warnings.push({ code: "ammo_no_supply", path: `${path}.ammo`, message: `"${attack.id}" of ${name(w)} spends item "${attack.ammo.item}", which nothing in the game gives` });
      }
      if (!player || !held.has(w.id)) return;
      if (attack.shape.type === "projectile" && !leaves(attack, player.size)) {
        warnings.push({ code: "projectile_short_lived", path: `${path}.shape`, message: `"${attack.id}" of ${name(w)}: its projectiles fade before they leave the player (raise speed or lifetime)` });
      } else if (smallest && !reachesTarget(attack, player.size, smallest.size)) {
        warnings.push({ code: "weapon_out_of_reach", path: `${path}.shape`, message: `"${attack.id}" of ${name(w)} can't reach an enemy the size of "${smallest.id}" (${smallest.size.width}x${smallest.size.height})` });
      }
    });
    if (!held.has(w.id)) return;
    const best = Math.max(...w.attacks.map((a) => a.damage));
    if (best <= 0) return;
    for (const e of enemies) {
      if (!spawned.has(e.id)) continue;
      if (waitedOn.has(e.id) && best >= e.stats.health) {
        warnings.push({ code: "weapon_one_shot", path: at, message: `${name(w)} beats "${e.id}" in one hit (${best} damage, ${e.stats.health} health), though the game waits on that fight` });
      } else if (Math.ceil(e.stats.health / best) > MAX_HITS) {
        warnings.push({ code: "weapon_too_weak", path: at, message: `${name(w)} needs ${Math.ceil(e.stats.health / best)} hits to beat "${e.id}" (more than ${MAX_HITS})` });
      }
    }
  });
  return warnings;
}

/** Enemies whose fights the game waits on: a health bar, a handler on their death, or a room that reacts to being cleared. */
function foughtFor(project: ProjectSpec): Set<string> {
  const out = new Set<string>();
  const killed = [...project.world.handlers, ...project.world.rooms.flatMap((r) => r.handlers)].filter((h) => h.on.type === "enemyKilled");
  for (const room of project.world.rooms) {
    const cleared = room.handlers.some((h) => h.on.type === "roomCleared") || project.world.handlers.some((h) => h.on.type === "roomCleared" && (h.on.room === undefined || h.on.room === room.id));
    for (const s of room.spawns) {
      const named = killed.some((h) => h.on.type === "enemyKilled" && (h.on.spawn === s.id || h.on.character === s.characterId));
      if (s.healthBar || s.handlers.some((h) => h.on.type === "enemyKilled") || named || cleared) out.add(s.characterId);
    }
  }
  return out;
}

/** Do the attack's projectiles get out of the wielder's box before they fade? */
function leaves(attack: WeaponAttack, body: BodySize): boolean {
  if (attack.shape.type !== "projectile") return true;
  const p = attack.shape.projectile;
  const inside = (q: XY) => Math.abs(q.x) < body.width / 2 && Math.abs(q.y) < body.height / 2;
  const aims = [...triggerAims(attack, "ground"), ...triggerAims(attack, "air")];
  return (aims.length ? aims : [AIM_VECTORS.forward]).some((aim) => fanHeadings(p, aim).some((h) => projectilePath(p, h).some((q) => !inside(q))));
}
