import type { ProjectSpec } from "../schema.ts";
import type { Effect } from "../events/events.ts";
import type { ProjectileLook } from "./animation.ts";
import { isObjectAsset, type CharacterAsset } from "./asset.ts";

/**
 * Where the game uses object assets (subject object): props drawn with one, spawnEffect effects,
 * projectile looks (weapon attacks, the enemy shoot action). Shared by deleteAsset (refuse while
 * in use), the lint, the game-art plan (draw the objects in use) and the studio.
 */

export interface ObjectUse {
  /** The object asset id. */
  object: string;
  /** Path in the project. */
  path: string;
  /** In the creator's words: "the prop lever in Arena". */
  what: string;
  /** Clips this use plays (null entries left out). */
  clips: string[];
}

function effectsOf(project: ProjectSpec): { path: string; effect: Effect }[] {
  const out: { path: string; effect: Effect }[] = [];
  const add = (path: string, handlers: { do: Effect[] }[]) => handlers.forEach((h, i) => h.do.forEach((effect, j) => out.push({ path: `${path}.${i}.do.${j}`, effect })));
  add("world.handlers", project.world.handlers);
  project.world.rooms.forEach((room, r) => {
    add(`world.rooms.${r}.handlers`, room.handlers);
    room.props.forEach((p, i) => add(`world.rooms.${r}.props.${i}.handlers`, p.handlers));
    room.spawns.forEach((s, i) => add(`world.rooms.${r}.spawns.${i}.handlers`, s.handlers));
  });
  project.world.modals.forEach((m, i) => m.buttons.forEach((b, j) => b.do.forEach((effect, k) => out.push({ path: `world.modals.${i}.buttons.${j}.do.${k}`, effect }))));
  return out;
}

const lookClips = (look: ProjectileLook): string[] => (look.art ? [look.art.charge, look.art.fly, look.art.burst].filter((c): c is string => c !== null) : []);

/** Every use of an object asset in the project (whether or not the asset exists). */
export function objectUses(project: ProjectSpec): ObjectUse[] {
  const uses: ObjectUse[] = [];
  project.world.rooms.forEach((room, r) =>
    room.props.forEach((p, i) => {
      if (p.art && "object" in p.art) uses.push({ object: p.art.object, path: `world.rooms.${r}.props.${i}.art`, what: `the prop "${p.name ?? p.id}" in "${room.name}"`, clips: p.art.idle ? [p.art.idle] : [] });
    }),
  );
  for (const { path, effect } of effectsOf(project)) {
    if (effect.type === "spawnEffect") uses.push({ object: effect.object, path, what: "a spawnEffect", clips: [effect.clip] });
  }
  project.weapons.list.forEach((w, i) =>
    w.attacks.forEach((a, j) => {
      if (a.shape.type === "projectile" && a.shape.projectile.look.art) {
        uses.push({ object: a.shape.projectile.look.art.object, path: `weapons.list.${i}.attacks.${j}.shape.projectile.look.art`, what: `the attack "${a.id}" of weapon "${w.id}"`, clips: lookClips(a.shape.projectile.look) });
      }
    }),
  );
  project.characters.forEach((c, i) => {
    if (c.kind !== "enemy") return;
    for (const [stateId, state] of Object.entries(c.behavior.states)) {
      if (state.action.type === "shoot" && state.action.look.art) {
        uses.push({ object: state.action.look.art.object, path: `characters.${i}.behavior.states.${stateId}.action.look.art`, what: `the shoot state "${stateId}" of "${c.id}"`, clips: lookClips(state.action.look) });
      }
    }
  });
  return uses;
}

/** The object assets of the project. */
export const objectAssets = (project: ProjectSpec): CharacterAsset[] => project.art.assets.filter(isObjectAsset);

/** Object assets the game uses (props, effects, projectiles), each once, in project order. */
export function usedObjects(project: ProjectSpec): CharacterAsset[] {
  const used = new Set(objectUses(project).map((u) => u.object));
  return objectAssets(project).filter((a) => used.has(a.id));
}

/** Clip names each used object needs: idle, plus every clip its uses play. */
export function wantedObjectClips(project: ProjectSpec, objectId: string): string[] {
  const clips = new Set<string>(["idle"]);
  for (const u of objectUses(project)) if (u.object === objectId) u.clips.forEach((c) => clips.add(c));
  for (const { effect } of effectsOf(project)) {
    if (effect.type !== "playAnimation") continue;
    const t = effect.target;
    if (t.kind === "prop") {
      const prop = project.world.rooms.flatMap((r) => r.props).find((p) => p.id === t.prop);
      if (prop?.art && "object" in prop.art && prop.art.object === objectId) clips.add(effect.clip);
    }
  }
  // A prop's own handlers playing on `self`.
  for (const room of project.world.rooms) {
    for (const p of room.props) {
      if (!(p.art && "object" in p.art && p.art.object === objectId)) continue;
      for (const h of p.handlers) for (const e of h.do) if (e.type === "playAnimation" && e.target.kind === "self") clips.add(e.clip);
    }
  }
  return [...clips];
}

export { effectsOf as handlerEffects };
