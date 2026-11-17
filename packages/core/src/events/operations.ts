import { z } from "zod";
import { Id } from "../common.ts";
import type { OperationResult } from "../operations.ts";
import type { ProjectSpec } from "../schema.ts";
import { fail, findRoom, known, parse, withRoom, withWorld } from "../world/opHelpers.ts";
import { Handler } from "./events.ts";

/** Handler operations: the world's, a room's, a prop's or a spawn's handlers. */

const Target = {
  roomId: Id.optional().describe("Omit for the world's handlers."),
  propId: Id.optional().describe("A prop in roomId."),
  spawnId: Id.optional().describe("An enemy spawn in roomId."),
};

type HandlerList = z.infer<typeof Handler>[];

function setAt(project: ProjectSpec, target: { roomId?: string; propId?: string; spawnId?: string }, change: (list: HandlerList) => HandlerList): OperationResult {
  if (!target.roomId) {
    if (target.propId || target.spawnId) return fail("invalid_input", "propId and spawnId need roomId");
    return withWorld(project, { handlers: change(project.world.handlers) });
  }
  if (target.propId && target.spawnId) return fail("invalid_input", "give propId or spawnId, not both");
  const found = findRoom(project, target.roomId);
  if (!found.ok) return found;
  const { room } = found;
  if (target.propId) {
    const i = room.props.findIndex((p) => p.id === target.propId);
    if (i < 0) return fail("not_found", `room "${room.id}" has no prop "${target.propId}"${known(room.props.map((p) => p.id))}`);
    const props = room.props.slice();
    props[i] = { ...props[i]!, handlers: change(props[i]!.handlers) };
    return withRoom(project, found.index, { ...room, props });
  }
  if (target.spawnId) {
    const i = room.spawns.findIndex((s) => s.id === target.spawnId);
    if (i < 0) return fail("not_found", `room "${room.id}" has no spawn "${target.spawnId}"${known(room.spawns.map((s) => s.id))}`);
    const spawns = room.spawns.slice();
    spawns[i] = { ...spawns[i]!, handlers: change(spawns[i]!.handlers) };
    return withRoom(project, found.index, { ...room, spawns });
  }
  return withRoom(project, found.index, { ...room, handlers: change(room.handlers) });
}

export const SetHandlersInput = z.strictObject({ ...Target, handlers: z.array(Handler).max(50) });

/** Replace a whole handler list. */
export function setHandlers(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(SetHandlersInput, input, "setHandlers");
  if (!p.ok) return p;
  return setAt(project, p.data, () => p.data.handlers);
}

export const AddHandlerInput = z.strictObject({ ...Target, handler: Handler });

/** Append one handler. */
export function addHandler(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(AddHandlerInput, input, "addHandler");
  if (!p.ok) return p;
  return setAt(project, p.data, (list) => [...list, p.data.handler]);
}

export const RemoveHandlerInput = z.strictObject({ ...Target, index: z.number().int().min(0) });

/** Remove one handler by its index in the list. */
export function removeHandler(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(RemoveHandlerInput, input, "removeHandler");
  if (!p.ok) return p;
  let missing = false;
  const result = setAt(project, p.data, (list) => {
    missing = p.data.index >= list.length;
    return list.filter((_, i) => i !== p.data.index);
  });
  return missing ? fail("not_found", `no handler at index ${p.data.index}`) : result;
}

export const handlerOperations = { setHandlers, addHandler, removeHandler };
