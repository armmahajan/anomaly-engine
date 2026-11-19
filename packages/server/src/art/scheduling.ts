import { attackClipName, wieldedWeapons, type ArtStepRequest, type ProjectSpec } from "@anomaly/core";
import { newBiomeName } from "@anomaly/art";

/**
 * Which art jobs may run at the same time. A job "touches" things (its keys):
 * a character family (an original and its variants), a character's art asset,
 * a weapon, a biome, a world room, a modal, the item icons. Two jobs conflict
 * when they share a key; jobs that write things everything depends on (the art
 * direction) or that plan over the whole game (gameArt) touch everything (`*`)
 * and run alone. Keys are read from the request and the project as it is when
 * the job would start; they err on the side of conflict.
 */

export const EVERYTHING = "*";

/** What jobKeys reads from a request: an art job request, or a game-art plan step's request. */
export type KeyedRequest = Pick<
  ArtStepRequest,
  "characterId" | "biomeId" | "biomeStep" | "dressRoom" | "worldRoomId" | "modalId" | "weaponId" | "clips" | "brief" | "name"
> & { stage: string; roomId?: string; clip?: string };

const CHARACTER_STAGES = new Set(["concepts", "choose", "rig", "animate", "auto"]);
/** Stages that write clips, and so may point weapon attacks at them (setWeaponAttack). */
const ANIMATING = new Set(["animate", "auto"]);

export function jobKeys(request: KeyedRequest, project: ProjectSpec): string[] {
  const keys = new Set<string>();
  if (request.stage === "artDirection" || request.stage === "gameArt") return [EVERYTHING];
  if (CHARACTER_STAGES.has(request.stage) && request.characterId) characterKeys(request, project, keys);
  if (request.weaponId) keys.add(`weapon:${request.weaponId}`);
  switch (request.stage) {
    case "worldKit":
      if (request.biomeId) biomeKeys(request.biomeId, project, keys);
      // A new biome's id comes from its name: two new biomes of the same name would pick the same id.
      else keys.add(request.brief?.trim() ? `biome-new:${newBiomeName(request.brief.trim(), request.name).slug}` : "biome-new");
      break;
    case "worldCompose":
    case "worldRepaint":
      if (request.biomeId) biomeKeys(request.biomeId, project, keys);
      break;
    case "propArt":
      if (request.worldRoomId) {
        keys.add(`room:${request.worldRoomId}`);
        // Props painted into the room's kit rewrite that biome's kit.
        const biome = project.world.rooms.find((r) => r.id === request.worldRoomId)?.dressing?.biome;
        if (biome) keys.add(`biome:${biome}`);
      }
      break;
    case "modalArt":
      if (request.modalId) keys.add(`modal:${request.modalId}`);
      break;
    case "itemArt":
      keys.add("items");
      break;
  }
  if (request.biomeStep) keys.add(`biomeStep:${request.biomeStep}`);
  if (request.dressRoom) keys.add(`room:${request.dressRoom}`);
  return [...keys];
}

/** A character job touches its family (an original and its variants share art), its asset and, when it animates, the weapons whose attacks it may write clips for. */
function characterKeys(request: KeyedRequest, project: ProjectSpec, keys: Set<string>): void {
  const character = project.characters.find((c) => c.id === request.characterId);
  const root = character?.kind === "enemy" && character.variantOf ? character.variantOf : request.characterId!;
  keys.add(`character:${root}`);
  if (character?.appearance) keys.add(`asset:${character.appearance}`);
  if (!ANIMATING.has(request.stage)) return;
  const sharing = character?.appearance ? project.characters.filter((c) => c.appearance === character.appearance) : character ? [character] : [];
  for (const c of [...sharing, ...project.characters.filter((v) => v.kind === "enemy" && v.variantOf === root)]) {
    for (const w of wieldedWeapons(project, c)) keys.add(`weapon:${w.id}`);
  }
  const named = new Set([...(request.clips ?? []), ...(request.clip ? [request.clip] : [])]);
  if (named.size > 0) {
    for (const w of project.weapons.list) if (w.attacks.some((a) => named.has(attackClipName(w, a)))) keys.add(`weapon:${w.id}`);
  }
}

/** A biome job touches the biome and every world room dressed with it (recomposing a room refreshes its dressing). */
function biomeKeys(biomeId: string, project: ProjectSpec, keys: Set<string>): void {
  keys.add(`biome:${biomeId}`);
  for (const room of project.world.rooms) if (room.dressing?.biome === biomeId) keys.add(`room:${room.id}`);
}

export function conflicts(a: readonly string[], b: readonly string[]): boolean {
  if (a.includes(EVERYTHING) || b.includes(EVERYTHING)) return true;
  const set = new Set(a);
  return b.some((k) => set.has(k));
}

/**
 * Split ordered items into lanes that can run side by side: items whose keys
 * overlap (directly or through others) share a lane, in their original order.
 * Lanes come out in the order of their first item.
 */
export function lanesOf<T>(items: readonly T[], keysOf: (item: T) => readonly string[]): T[][] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const owner = new Map<string, number>();
  items.forEach((item, i) => {
    for (const key of keysOf(item)) {
      const j = owner.get(key);
      if (j === undefined) owner.set(key, i);
      else parent[find(i)] = find(j);
    }
  });
  const lanes = new Map<number, T[]>();
  items.forEach((item, i) => {
    const root = find(i);
    lanes.set(root, [...(lanes.get(root) ?? []), item]);
  });
  // Map keeps insertion order: a lane's first item came before later lanes' first items.
  return [...lanes.values()];
}

/**
 * Run lanes with at most `limit` at once; each lane's items run in order. The
 * first failure stops lanes from starting more items (items already running
 * finish), then is thrown.
 */
export async function runLanes<T>(lanes: readonly T[][], limit: number, each: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (!failure && next < lanes.length) {
      const lane = lanes[next++]!;
      for (const item of lane) {
        if (failure) return;
        try {
          await each(item);
        } catch (error) {
          failure ??= { error };
          return;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, lanes.length)) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
}
