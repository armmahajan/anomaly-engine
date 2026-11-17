import type { ProjectSpec } from "../schema.ts";
import { flattenConditions, type GameCondition, type Handler } from "./events.ts";

/** A lint warning from one domain (events, props, modals, combat): a short code, a message and a dotted path. */
export interface DomainWarning {
  code: string;
  message: string;
  path: string;
}

/** Every handler list in the project with its dotted path. */
export function allHandlers(project: ProjectSpec): { path: string; handlers: Handler[] }[] {
  const { world } = project;
  return [
    { path: "world.handlers", handlers: world.handlers },
    ...world.rooms.flatMap((room, r) => [
      { path: `world.rooms.${r}.handlers`, handlers: room.handlers },
      ...room.props.map((p, i) => ({ path: `world.rooms.${r}.props.${i}.handlers`, handlers: p.handlers })),
      ...room.spawns.map((s, i) => ({ path: `world.rooms.${r}.spawns.${i}.handlers`, handlers: s.handlers })),
    ]),
  ];
}

/** Every condition the project reads (handlers' and props' solid/visible), with its path. */
function allConditions(project: ProjectSpec): { path: string; condition: GameCondition }[] {
  const out: { path: string; condition: GameCondition }[] = [];
  for (const { path, handlers } of allHandlers(project)) {
    handlers.forEach((h, i) => flattenConditions(h.when).forEach((condition) => out.push({ path: `${path}.${i}.when`, condition })));
  }
  project.world.rooms.forEach((room, r) =>
    room.spawns.forEach((spawn, i) => spawn.when && flattenConditions([spawn.when]).forEach((condition) => out.push({ path: `world.rooms.${r}.spawns.${i}.when`, condition }))),
  );
  project.world.rooms.forEach((room, r) =>
    room.props.forEach((prop, i) =>
      (["solid", "visible"] as const).forEach((key) => {
        const value = prop[key];
        if (typeof value !== "boolean") flattenConditions([value]).forEach((condition) => out.push({ path: `world.rooms.${r}.props.${i}.${key}`, condition }));
      }),
    ),
  );
  return out;
}

/** Likely mistakes in game logic: flags read but never set, timers waited on but never started. */
export function lintEvents(project: ProjectSpec): DomainWarning[] {
  const warnings: DomainWarning[] = [];
  const effects = allHandlers(project).flatMap(({ handlers }) => handlers.flatMap((h) => h.do));
  const modalEffects = project.world.modals.flatMap((m) => m.buttons.flatMap((b) => b.do));
  const all = [...effects, ...modalEffects];
  const setFlags = new Set(all.flatMap((e) => (e.type === "setFlag" ? [e.flag] : [])));
  const timers = new Set(all.flatMap((e) => (e.type === "startTimer" ? [e.timer] : [])));
  const reported = new Set<string>();
  for (const { path, condition } of allConditions(project)) {
    if (condition.type === "flag" && !setFlags.has(condition.flag) && !reported.has(condition.flag)) {
      reported.add(condition.flag);
      warnings.push({ code: "flag_never_set", path, message: `flag "${condition.flag}" is checked but nothing sets it (setFlag)` });
    }
  }
  for (const { path, handlers } of allHandlers(project)) {
    handlers.forEach((h, i) => {
      if (h.on.type === "timer" && !timers.has(h.on.timer)) {
        warnings.push({ code: "timer_never_started", path: `${path}.${i}.on`, message: `timer "${h.on.timer}" is waited on but nothing starts it (startTimer)` });
      }
    });
  }
  return warnings;
}
