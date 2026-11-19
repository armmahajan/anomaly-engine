import type { ProjectSpec } from "../schema.ts";
import type { DomainWarning } from "../events/lint.ts";
import type { AnimTarget } from "./animation.ts";
import type { Effect, Handler } from "../events/events.ts";
import { isObjectAsset, type CharacterAsset } from "./asset.ts";
import { objectUses } from "./objects.ts";

/**
 * Animation references: objects that aren't object assets, clips an object or a character's art
 * doesn't have, and playAnimation / spawnEffect targets that can't be found. Clips are checked only
 * once the art has clips (an object not drawn yet gets its clips from the game-art job).
 */
export function lintAnimation(project: ProjectSpec): DomainWarning[] {
  const warnings: DomainWarning[] = [];
  const assets = new Map(project.art.assets.map((a) => [a.id, a]));
  const clipsOf = (assetId: string | undefined): string[] | null => {
    const a = assetId ? assets.get(assetId) : undefined;
    if (!a || a.kind !== "character") return null;
    const names = Object.keys(a.clips);
    return names.length ? names : null; // not drawn yet: nothing to check against
  };
  const objectClipCheck = (object: string, clip: string, path: string, what: string) => {
    const known = clipsOf(object);
    if (known && !known.includes(clip)) warnings.push({ code: "anim_clip_unknown", path, message: `${what} plays clip "${clip}", which object "${object}" doesn't have (${known.join(", ")})` });
  };

  for (const use of objectUses(project)) {
    if (!isObjectAsset(assets.get(use.object))) {
      warnings.push({ code: "object_unknown", path: use.path, message: `${use.what} uses "${use.object}", which isn't an object asset (createObject makes one)` });
      continue;
    }
    for (const clip of use.clips) objectClipCheck(use.object, clip, use.path, use.what);
  }

  const appearanceOf = (characterId: string) => project.characters.find((c) => c.id === characterId)?.appearance;
  const player = project.characters.find((c) => c.kind === "player");
  const checkEffects = (handlers: Handler[], path: string, scope: { room?: ProjectSpec["world"]["rooms"][number]; self?: { kind: "prop" | "spawn"; id: string } }) => {
    handlers.forEach((h, i) =>
      h.do.forEach((e: Effect, j) => {
        const at = `${path}.${i}.do.${j}`;
        if (e.type !== "playAnimation" && e.type !== "spawnEffect") return;
        const target: AnimTarget | { kind: "point" } = e.type === "playAnimation" ? e.target : e.at;
        if (target.kind === "self" && !scope.self) {
          warnings.push({ code: "anim_self_outside", path: at, message: `${e.type} targets "self", but this handler isn't on a prop or an enemy spawn` });
          return;
        }
        if ((target.kind === "prop" || target.kind === "spawn") && scope.room) {
          const id = target.kind === "prop" ? target.prop : target.spawn;
          const found = target.kind === "prop" ? scope.room.props.some((p) => p.id === id) : scope.room.spawns.some((s) => s.id === id);
          if (!found) warnings.push({ code: "anim_target_unknown", path: at, message: `${e.type} targets ${target.kind} "${id}", which room "${scope.room.id}" doesn't have` });
        }
        if (e.type !== "playAnimation") return;
        // The art the target plays from.
        const resolved: { kind: "prop" | "spawn"; id: string } | null =
          target.kind === "self" ? scope.self! : target.kind === "prop" ? { kind: "prop", id: target.prop } : target.kind === "spawn" ? { kind: "spawn", id: target.spawn } : null;
        let assetId: string | undefined;
        if (target.kind === "player") assetId = player?.appearance;
        else if (resolved && scope.room) {
          if (resolved.kind === "prop") {
            const prop = scope.room.props.find((p) => p.id === resolved.id);
            if (prop && !(prop.art && "object" in prop.art)) {
              warnings.push({ code: "anim_prop_not_object", path: at, message: `playAnimation plays "${e.clip}" on prop "${resolved.id}", which isn't drawn with an object (give it object art)` });
              return;
            }
            assetId = prop?.art && "object" in prop.art ? prop.art.object : undefined;
          } else {
            const spawn = scope.room.spawns.find((s) => s.id === resolved.id);
            assetId = spawn ? appearanceOf(spawn.characterId) : undefined;
          }
        }
        const known = clipsOf(assetId);
        if (known && !known.includes(e.clip)) warnings.push({ code: "anim_clip_unknown", path: at, message: `playAnimation plays "${e.clip}", which "${assetId}" doesn't have (${known.join(", ")})` });
      }),
    );
  };
  checkEffects(project.world.handlers, "world.handlers", {});
  project.world.rooms.forEach((room, r) => {
    checkEffects(room.handlers, `world.rooms.${r}.handlers`, { room });
    room.props.forEach((p, i) => checkEffects(p.handlers, `world.rooms.${r}.props.${i}.handlers`, { room, self: { kind: "prop", id: p.id } }));
    room.spawns.forEach((s, i) => checkEffects(s.handlers, `world.rooms.${r}.spawns.${i}.handlers`, { room, self: { kind: "spawn", id: s.id } }));
  });
  project.world.modals.forEach((m, i) => m.buttons.forEach((b, j) => checkEffects([{ on: { type: "gameStarted" }, when: [], do: b.do }], `world.modals.${i}.buttons.${j}`, {})));
  return warnings;
}

/** The object asset `id`, if it is one. */
export const objectAsset = (project: ProjectSpec, id: string): CharacterAsset | undefined => {
  const a = project.art.assets.find((x) => x.id === id);
  return isObjectAsset(a) ? a : undefined;
};
