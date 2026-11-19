import { z } from "zod";
import type { PropSwitch } from "@anomaly/core";
import type { DomainTools } from "./types.ts";
import { describeHandler } from "./handlers.ts";

type Op = "addProp" | "updateProp" | "removeProp" | "createItem" | "updateItem" | "deleteItem";

/** Compact schemas for the model (the operations validate fully). */
const id = z.string();
const fieldsOf = (what: string) => z.looseObject({}).describe(what);
const fields = {
  name: z.string().optional(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  color: z.string().optional(),
  solid: z.unknown().optional().describe('bool or condition, e.g. {type: "flag", flag: "open", is: false}'),
  visible: z.unknown().optional().describe("same; hidden = gone"),
  health: z.number().nullable().optional(),
  bounce: z.boolean().optional(),
  prompt: z.string().nullable().optional(),
  handlers: z.array(z.unknown()).optional(),
};
const itemFields = { name: z.string(), description: z.string().optional(), color: z.string().optional() };

export const propTools: DomainTools<Op> = {
  descriptions: {
    addProp:
      "Add a prop: a rectangle in a room (px, top-left). Handlers hear touch, interact (Up; shows prompt), hit (the player's attacks; bounce: down strikes bounce), destroyed (`health` hits). Pickups, barriers, switches = props + flags + items + handlers.",
    updateProp: "Change the given fields of a prop (also id, art {biome, piece}).",
    removeProp: "Remove a prop from a room.",
    createItem: "Create an item the player can carry (counted); id from the name.",
    updateItem: "Change an item.",
    deleteItem: "Delete an item (refused while anything uses it).",
  },
  schemas: {
    addProp: z.strictObject({ roomId: id, id: id.optional(), ...fields }),
    updateProp: z.strictObject({ roomId: id, propId: id, changes: fieldsOf("addProp fields; id renames") }),
    removeProp: z.strictObject({ roomId: id, propId: id }),
    createItem: z.strictObject({ id: id.optional(), ...itemFields }),
    updateItem: z.strictObject({ itemId: id, changes: fieldsOf("name, description, color") }),
    deleteItem: z.strictObject({ itemId: id }),
  },
  summary: (project) => {
    const lines: string[] = [];
    const show = (v: PropSwitch) => (typeof v === "boolean" ? String(v) : JSON.stringify(v));
    for (const room of project.world.rooms) {
      for (const p of room.props) {
        const extras = [
          p.solid !== false && `solid ${show(p.solid)}`,
          p.visible !== true && `visible ${show(p.visible)}`,
          p.health !== null && `health ${p.health}`,
          p.bounce && "bounce",
          p.prompt && `prompt "${p.prompt}"`,
          p.art && `art ${p.art.biome}/${p.art.piece}`,
        ].filter(Boolean);
        lines.push(`- prop ${room.id}/${p.id}${p.name ? ` "${p.name}"` : ""} (${p.x}, ${p.y}) ${p.width}x${p.height}${extras.length ? `; ${extras.join(", ")}` : ""}`);
        p.handlers.forEach((h, i) => lines.push(`  [${i}] ${describeHandler(h)}`));
      }
    }
    const items = project.world.items.map((i) => `${i.id} "${i.name}"`);
    return [lines.length ? "Props:" : "Props: none.", ...lines, `Items: ${items.length ? items.join(", ") : "none"}.`];
  },
};
