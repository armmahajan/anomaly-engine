import type { z } from "zod";
import type { OperationError, OperationResult } from "../operations.ts";
import { ProjectSpec } from "../schema.ts";
import { gridCols, gridRows, TILE } from "./tiles.ts";
import type { World, WorldRoom } from "./world.ts";

/** Shared helpers for operations on the game world (rooms, props, modals, items, handlers, ...). */

export type Fail = { ok: false; error: OperationError };

export const fail = (code: OperationError["code"], message: string, issues: OperationError["issues"] = []): Fail => ({
  ok: false,
  error: { code, message, issues },
});
export const issuesOf = (error: z.ZodError, prefix = "") => error.issues.map((i) => ({ path: prefix + i.path.join("."), message: i.message }));
export const known = (ids: string[]) => (ids.length > 0 ? ` (known: ${ids.join(", ")})` : " (none exist)");

export function parse<T extends z.ZodType>(schema: T, input: unknown, op: string): { ok: true; data: z.infer<T> } | Fail {
  const parsed = schema.safeParse(input);
  return parsed.success ? { ok: true, data: parsed.data } : fail("invalid_input", `${op} input is malformed`, issuesOf(parsed.error));
}

export function commit(next: ProjectSpec): OperationResult {
  const parsed = ProjectSpec.safeParse({ ...next, revision: next.revision + 1 });
  if (!parsed.success) {
    const issues = issuesOf(parsed.error);
    return fail("invalid_result", `operation would leave the project invalid: ${issues.map((i) => i.message).join("; ")}`, issues);
  }
  return { ok: true, project: parsed.data };
}

export const withWorld = (project: ProjectSpec, world: Partial<World>): OperationResult => commit({ ...project, world: { ...project.world, ...world } });

export function findRoom(project: ProjectSpec, roomId: string): { ok: true; index: number; room: WorldRoom } | Fail {
  const index = project.world.rooms.findIndex((r) => r.id === roomId);
  if (index < 0) return fail("not_found", `no room "${roomId}"${known(project.world.rooms.map((r) => r.id))}`);
  return { ok: true, index, room: project.world.rooms[index]! };
}

export function withRoom(project: ProjectSpec, index: number, room: WorldRoom): OperationResult {
  const rooms = project.world.rooms.slice();
  rooms[index] = room;
  return withWorld(project, { rooms });
}

export const roomSize = (room: WorldRoom) => ({ width: gridCols(room.grid) * TILE, height: gridRows(room.grid) * TILE });

export function checkInside(room: WorldRoom, x: number, y: number, what: string): Fail | null {
  const { width, height } = roomSize(room);
  return x < 0 || x > width || y < 0 || y > height ? fail("invalid_input", `${what} (${x}, ${y}) is outside room "${room.id}" (${width}x${height} px)`) : null;
}

