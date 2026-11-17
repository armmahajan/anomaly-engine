import { z } from "zod";
import { Id } from "../common.ts";
import type { OperationResult } from "../operations.ts";
import type { ProjectSpec } from "../schema.ts";
import { RoomSpawn } from "../world/world.ts";
import { fail, findRoom, known, parse, withRoom } from "../world/opHelpers.ts";

/** Enemy combat operations: what a spawn shows while it fights. */

export const SetSpawnHealthBarInput = z.strictObject({
  roomId: Id,
  spawnId: Id,
  healthBar: RoomSpawn.shape.healthBar.unwrap().describe("{title} shows a titled health bar while it lives in the current room; null hides it."),
});

/** Show (or hide) a titled health bar for one enemy spawn while it is alive in the current room. */
export function setSpawnHealthBar(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(SetSpawnHealthBarInput, input, "setSpawnHealthBar");
  if (!p.ok) return p;
  const found = findRoom(project, p.data.roomId);
  if (!found.ok) return found;
  const { room } = found;
  const i = room.spawns.findIndex((s) => s.id === p.data.spawnId);
  if (i < 0) return fail("not_found", `room "${room.id}" has no spawn "${p.data.spawnId}"${known(room.spawns.map((s) => s.id))}`);
  const spawns = room.spawns.slice();
  spawns[i] = { ...spawns[i]!, healthBar: p.data.healthBar };
  return withRoom(project, found.index, { ...room, spawns });
}

export const combatOperations = { setSpawnHealthBar };
