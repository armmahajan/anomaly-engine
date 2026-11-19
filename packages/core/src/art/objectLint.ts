import type { ProjectSpec } from "../schema.ts";
import type { DomainWarning } from "../events/lint.ts";
import type { AnimTarget } from "./animation.ts";
import type { Effect, Handler } from "../events/events.ts";
import { isObjectAsset, type CharacterAsset } from "./asset.ts";
import { objectUses } from "./objects.ts";

/**
 * Animation references: objects that aren't object assets, clips an object or a character's art
 * doesn't have, playAnimation / spawnEffect / setLook / clearLook / dissolve / emit targets that can't
 * be found, and stateEntered waiting for a state its enemy doesn't have. Clips are checked only
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
        const target: AnimTarget | { kind: "point" } | null =
          e.type === "playAnimation" || e.type === "setLook" || e.type === "clearLook" || e.type === "dissolve" ? e.target : e.type === "spawnEffect" || e.type === "emit" ? e.at : null;
        if (!target) return;
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
  // stateEntered waiting for a state its enemy doesn't have (a spawn's own, or a world/room handler's `from` spawn).
  type Room = ProjectSpec["world"]["rooms"][number];
  const statesOf = (room: Room | undefined, spawnId: string): string[] | null => {
    const spawn = room?.spawns.find((s) => s.id === spawnId);
    const character = spawn && project.characters.find((c) => c.id === spawn.characterId);
    return character && character.kind === "enemy" ? Object.keys(character.behavior.states) : null;
  };
  const checkStates = (handlers: Handler[], path: string, room: Room | undefined, self: string | undefined) => {
    handlers.forEach((h, i) => {
      if (h.on.type !== "stateEntered" || h.on.state === undefined) return;
      const spawnId = self ?? (h.on.from?.kind === "spawn" ? h.on.from.spawn : undefined);
      const known = spawnId ? statesOf(room, spawnId) : null;
      if (known && !known.includes(h.on.state)) {
        warnings.push({ code: "anim_state_unknown", path: `${path}.${i}.on`, message: `stateEntered waits for state "${h.on.state}", which spawn "${spawnId}"'s enemy doesn't have (${known.join(", ")})` });
      }
    });
  };
  project.world.rooms.forEach((room, r) => {
    checkStates(room.handlers, `world.rooms.${r}.handlers`, room, undefined);
    room.spawns.forEach((s, i) => checkStates(s.handlers, `world.rooms.${r}.spawns.${i}.handlers`, room, s.id));
  });

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
