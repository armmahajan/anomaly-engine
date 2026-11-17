import { z } from "zod";
import { Id, RemoveHandlerInput, type Handler as HandlerType } from "@anomaly/core";
import type { DomainTools } from "./types.ts";

/** A compact handler spec for the model (listGameLogic has the details; the operations validate fully). */
const HandlerSpec = z
  .record(z.string(), z.unknown())
  .describe('{on: {type, ...filters}, when?: [conditions], do: [effects]}, e.g. {on: {type: "interact"}, when: [{type: "item", item: "key"}], do: [{type: "setFlag", flag: "gate_open"}]}. See listGameLogic.');
const target = { roomId: Id.optional(), propId: Id.optional(), spawnId: Id.optional() };

const where = "Target: omit roomId for the world's handlers; roomId alone for a room's; roomId + propId for a prop's; roomId + spawnId for an enemy spawn's.";

export const handlerTools: DomainTools<"setHandlers" | "addHandler" | "removeHandler"> = {
  descriptions: {
    addHandler: `Add a handler: when an event happens (on) and every condition holds (when), run effects (do) in order. ${where}`,
    setHandlers: `Replace a whole handler list. ${where}`,
    removeHandler: `Remove one handler by its index in the list. ${where}`,
  },
  schemas: {
    addHandler: z.strictObject({ ...target, handler: HandlerSpec }),
    setHandlers: z.strictObject({ ...target, handlers: z.array(HandlerSpec) }),
    removeHandler: RemoveHandlerInput,
  },
  summary: (project) => {
    const lines: string[] = [];
    const list = (label: string, handlers: HandlerType[]) => handlers.forEach((h, i) => lines.push(`- ${label}[${i}] ${describeHandler(h)}`));
    list("world", project.world.handlers);
    for (const room of project.world.rooms) {
      list(`room ${room.id} `, room.handlers);
      for (const spawn of room.spawns) list(`spawn ${room.id}/${spawn.id} `, spawn.handlers);
    }
    return lines.length ? ["Handlers (game rules are presets on top; prop handlers are listed with props):", ...lines] : ["Handlers: none besides the game rules."];
  },
};

/** One line: on <event>(<filters>) [when ...] do <effects>. */
export function describeHandler(h: HandlerType): string {
  const params = (o: object) => {
    const rest = Object.entries(o).filter(([k]) => k !== "type");
    return rest.length ? `(${rest.map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(", ")})` : "";
  };
  const when = h.when.length ? ` when ${h.when.map((c) => `${c.type}${params(c)}`).join(" and ")}` : "";
  return `on ${h.on.type}${params(h.on)}${when} do ${h.do.map((e) => `${e.type}${params(e)}`).join(", ")}`;
}

