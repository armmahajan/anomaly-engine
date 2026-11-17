import { z } from "zod";
import { Color, Id } from "../common.ts";
import { slugify, uniqueId } from "../ids.ts";
import type { OperationResult } from "../operations.ts";
import type { ProjectSpec } from "../schema.ts";
import { flattenConditions, Handler, type Effect, type GameCondition } from "../events/events.ts";
import { fail, findRoom, known, parse, withRoom, withWorld, type Fail } from "../world/opHelpers.ts";
import { Item, Prop, PropSwitch, type WorldRoom } from "../world/world.ts";

/**
 * Prop and item operations. Props are generic rectangles in a room (what one
 * is for comes from its look, conditions and handlers); items are counted
 * things the player carries. Same contract as ../operations.ts: pure,
 * untrusted input, whole-project check.
 */

// --- props -------------------------------------------------------------------

export const AddPropInput = Prop.extend({
  roomId: Id,
  id: Id.optional().describe("Defaults to the name in snake_case, else prop_<n>."),
});

export function addProp(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(AddPropInput, input, "addProp");
  if (!p.ok) return p;
  const { roomId, id: wanted, ...fields } = p.data;
  const found = findRoom(project, roomId);
  if (!found.ok) return found;
  const taken = found.room.props.map((x) => x.id);
  if (wanted && taken.includes(wanted)) return fail("invalid_input", `room "${roomId}" already has a prop "${wanted}"`);
  let id = wanted;
  if (!id && fields.name) id = uniqueId(slugify(fields.name, "prop"), taken);
  if (!id) {
    let n = 1;
    while (taken.includes(`prop_${n}`)) n++;
    id = `prop_${n}`;
  }
  return withRoom(project, found.index, { ...found.room, props: [...found.room.props, { id, ...fields }] });
}

/** Prop fields to change (no defaults: a field left out stays as it is). */
export const PropChanges = z.strictObject({
  id: Id.optional().describe("Rename the prop."),
  name: z.string().max(80).nullable().optional().describe("null clears it."),
  x: z.number().optional(),
  y: z.number().optional(),
  width: Prop.shape.width.optional(),
  height: Prop.shape.height.optional(),
  color: Color.optional(),
  art: Prop.shape.art.unwrap().optional(),
  solid: PropSwitch.optional(),
  visible: PropSwitch.optional(),
  health: Prop.shape.health.unwrap().optional(),
  bounce: z.boolean().optional(),
  prompt: Prop.shape.prompt.unwrap().optional(),
  handlers: z.array(Handler).max(50).optional(),
});

export const UpdatePropInput = z.strictObject({ roomId: Id, propId: Id, changes: PropChanges });

function findProp(room: WorldRoom, propId: string): { ok: true; index: number; prop: Prop } | Fail {
  const index = room.props.findIndex((x) => x.id === propId);
  if (index < 0) return fail("not_found", `room "${room.id}" has no prop "${propId}"${known(room.props.map((x) => x.id))}`);
  return { ok: true, index, prop: room.props[index]! };
}

export function updateProp(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(UpdatePropInput, input, "updateProp");
  if (!p.ok) return p;
  const found = findRoom(project, p.data.roomId);
  if (!found.ok) return found;
  const f = findProp(found.room, p.data.propId);
  if (!f.ok) return f;
  const { name, ...changes } = p.data.changes;
  if (changes.id && changes.id !== f.prop.id && found.room.props.some((x) => x.id === changes.id)) {
    return fail("invalid_input", `room "${found.room.id}" already has a prop "${changes.id}"`);
  }
  const { name: current, ...rest } = f.prop;
  const kept = name === undefined ? current : (name ?? undefined);
  const prop: Prop = {
    ...rest,
    ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)),
    ...(kept !== undefined && { name: kept }),
  };
  const props = found.room.props.slice();
  props[f.index] = prop;
  return withRoom(project, found.index, { ...found.room, props });
}

export const PropRef = z.strictObject({ roomId: Id, propId: Id });

export function removeProp(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(PropRef, input, "removeProp");
  if (!p.ok) return p;
  const found = findRoom(project, p.data.roomId);
  if (!found.ok) return found;
  const f = findProp(found.room, p.data.propId);
  if (!f.ok) return f;
  return withRoom(project, found.index, { ...found.room, props: found.room.props.filter((x) => x.id !== p.data.propId) });
}

// --- items -------------------------------------------------------------------

export const CreateItemInput = Item.extend({ id: Id.optional().describe("Defaults to the name in snake_case.") });

export function createItem(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(CreateItemInput, input, "createItem");
  if (!p.ok) return p;
  const taken = project.world.items.map((i) => i.id);
  if (p.data.id && taken.includes(p.data.id)) return fail("invalid_input", `an item "${p.data.id}" already exists`);
  const item: Item = { ...p.data, id: p.data.id ?? uniqueId(slugify(p.data.name, "item"), taken) };
  return withWorld(project, { items: [...project.world.items, item] });
}

export const UpdateItemInput = z.strictObject({
  itemId: Id,
  changes: z.strictObject({ name: Item.shape.name.optional(), description: z.string().max(400).optional(), color: Color.optional(), icon: Item.shape.icon.describe("A picture of it, a file in the project's asset store (the item art job draws these).") }),
});

export function updateItem(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(UpdateItemInput, input, "updateItem");
  if (!p.ok) return p;
  const index = project.world.items.findIndex((i) => i.id === p.data.itemId);
  if (index < 0) return fail("not_found", `no item "${p.data.itemId}"${known(project.world.items.map((i) => i.id))}`);
  const items = project.world.items.slice();
  items[index] = { ...items[index]!, ...Object.fromEntries(Object.entries(p.data.changes).filter(([, v]) => v !== undefined)) };
  return withWorld(project, { items });
}

export const ItemRef = z.strictObject({ itemId: Id });

/** Where an item is named: handler conditions and effects, prop solid/visible conditions, modal buttons. */
export function itemUses(project: ProjectSpec, itemId: string): string[] {
  const names = (c: GameCondition) => c.type === "item" && c.item === itemId;
  const moves = (e: Effect) => (e.type === "giveItem" || e.type === "takeItem") && e.item === itemId;
  const uses: string[] = [];
  const handlers = (label: string, list: Handler[]) =>
    list.forEach((h, i) => {
      if (flattenConditions(h.when).some(names) || h.do.some(moves)) uses.push(`${label} handler ${i}`);
    });
  handlers("the game's", project.world.handlers);
  for (const room of project.world.rooms) {
    handlers(`room ${room.id}`, room.handlers);
    room.spawns.forEach((s) => handlers(`spawn ${room.id}/${s.id}`, s.handlers));
    for (const prop of room.props) {
      for (const key of ["solid", "visible"] as const) {
        const value = prop[key];
        if (typeof value !== "boolean" && flattenConditions([value]).some(names)) uses.push(`prop ${room.id}/${prop.id} (${key})`);
      }
      handlers(`prop ${room.id}/${prop.id}`, prop.handlers);
    }
  }
  project.world.modals.forEach((m) => m.buttons.forEach((b, i) => b.do.some(moves) && uses.push(`modal ${m.id} button ${i}`)));
  return uses;
}

export function deleteItem(project: ProjectSpec, input: unknown): OperationResult {
  const p = parse(ItemRef, input, "deleteItem");
  if (!p.ok) return p;
  const { itemId } = p.data;
  if (!project.world.items.some((i) => i.id === itemId)) return fail("not_found", `no item "${itemId}"${known(project.world.items.map((i) => i.id))}`);
  const uses = itemUses(project, itemId);
  if (uses.length > 0) return fail("invalid_input", `item "${itemId}" is still used by ${uses.join(", ")}; change those first`);
  return withWorld(project, { items: project.world.items.filter((i) => i.id !== itemId) });
}

export const propOperations = { addProp, updateProp, removeProp, createItem, updateItem, deleteItem };
