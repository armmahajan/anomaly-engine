import { isObjectAsset, objectAssets, slugify, uniqueId, type AnimTarget, type CharacterAsset, type ProjectSpec, type PropArt, type WorldRoom } from "@anomaly/core";

/**
 * What the studio's pickers offer for animation references (objects, their clips, the room's props
 * and spawns, marker names), worked out from the project. Pure, so the editors stay thin.
 */

/** Where a handler sits: its room, and the prop or enemy spawn it belongs to (`self`). */
export interface HandlerPlace {
  room: WorldRoom | null;
  self: { kind: "prop" | "spawn"; id: string } | null;
}

/** createObject for a new object named `name`: its id from the name, unique among the assets. */
export function newObjectCall(project: ProjectSpec, name: string, brief: string): { name: "createObject"; input: { id: string; name: string; brief: string } } {
  const id = uniqueId(slugify(name, "object"), project.art.assets.map((a) => a.id));
  return { name: "createObject", input: { id, name: name.trim().slice(0, 80), brief: brief.trim() } };
}

export const objectIds = (project: ProjectSpec): string[] => objectAssets(project).map((a) => a.id);

const characterArt = (project: ProjectSpec, assetId: string | undefined): CharacterAsset | undefined => {
  const a = assetId ? project.art.assets.find((x) => x.id === assetId) : undefined;
  return a?.kind === "character" ? a : undefined;
};

/** Clip names of an asset (an object, a character's art), in its order. */
export const clipsOf = (project: ProjectSpec, assetId: string | undefined): string[] => Object.keys(characterArt(project, assetId)?.clips ?? {});

/** The object a prop is drawn with, if any. */
const propObject = (art: PropArt | null | undefined): string | undefined => (art && "object" in art ? art.object : undefined);

/** The art (asset id) a playAnimation target plays from: a prop's object, a spawn's or the player's appearance. */
export function targetAsset(project: ProjectSpec, target: AnimTarget | undefined, place: HandlerPlace): string | undefined {
  const t = target ?? { kind: "self" as const };
  const appearance = (characterId: string | undefined) => project.characters.find((c) => c.id === characterId)?.appearance;
  const resolved = t.kind === "self" ? place.self : t.kind === "prop" ? { kind: "prop" as const, id: t.prop } : t.kind === "spawn" ? { kind: "spawn" as const, id: t.spawn } : null;
  if (t.kind === "player") return appearance(project.characters.find((c) => c.kind === "player")?.id);
  if (!resolved || !place.room) return undefined;
  if (resolved.kind === "prop") return propObject(place.room.props.find((p) => p.id === resolved.id)?.art);
  return appearance(place.room.spawns.find((s) => s.id === resolved.id)?.characterId);
}

/**
 * Clip choices for the `clip` field of an effect being edited: a playAnimation's are its target's
 * clips, a spawnEffect's its object's. Null when the art has no clips yet (the field stays free text).
 */
export function clipChoices(project: ProjectSpec, effect: Record<string, unknown>, place: HandlerPlace): string[] | null {
  const assetId = effect.type === "spawnEffect" ? (effect.object as string | undefined) : effect.type === "playAnimation" ? targetAsset(project, effect.target as AnimTarget | undefined, place) : undefined;
  const clips = clipsOf(project, assetId);
  return clips.length ? clips : null;
}

/**
 * Marker names a marker event can listen for: on a prop or spawn, its own art's markers; elsewhere
 * (`from` given: that one's) every marker of every clip. Null when none are known (free text).
 */
export function markerChoices(project: ProjectSpec, event: Record<string, unknown>, place: HandlerPlace): string[] | null {
  const from = event.from as AnimTarget | undefined;
  const assets = place.self || from ? [characterArt(project, targetAsset(project, from ?? { kind: "self" }, place))] : project.art.assets.map((a) => (a.kind === "character" ? a : undefined));
  const names = [...new Set(assets.flatMap((a) => Object.values(a?.clips ?? {}).flatMap((c) => c.markers.map((m) => m.name))))];
  return names.length ? names : null;
}

/** The prop art picker's value: "" (its colour), "kit:<biome>/<piece>" or "object:<id>". */
export function propArtValue(art: PropArt | null): string {
  if (!art) return "";
  return "biome" in art ? `kit:${art.biome}/${art.piece}` : `object:${art.object}`;
}

/** The prop art for a picker value; an object keeps the scale it had and loops its idle clip if it has one (else its first, else rest). */
export function propArtFrom(project: ProjectSpec, value: string, current: PropArt | null): PropArt | null {
  if (value.startsWith("kit:")) {
    const [biome, piece] = value.slice(4).split("/");
    return biome && piece ? { biome, piece } : null;
  }
  if (value.startsWith("object:")) {
    const object = value.slice(7);
    const asset = project.art.assets.find((a) => a.id === object);
    const clips = isObjectAsset(asset) ? Object.keys(asset.clips) : [];
    const idle = clips.includes("idle") || clips.length === 0 ? "idle" : clips[0]!;
    const scale = current && "object" in current ? current.scale : 1;
    return { object, idle, scale };
  }
  return null;
}
