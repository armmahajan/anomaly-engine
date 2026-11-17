import { z } from "zod";
import { checkGame, gateChecks, MovementAbility, type LogicStep } from "@anomaly/core";
import type { DomainTools } from "./types.ts";

const CheckInput = z.strictObject({
  abilities: z.array(MovementAbility).max(5).optional().describe("Abilities the player starts with (default none)."),
  withoutAbilities: z.array(MovementAbility).max(5).optional().describe("Abilities the player never gets, for gate checks: is a room reachable without them?"),
});

/** Moves inside a room ("jump to (336, 256)") say little in a summary; events and doors are kept. */
const telling = (s: LogicStep) => !/^(walk|jump|drop|climb|pound|land at) (to )?\(/.test(s.action) && s.action !== "start";
const line = (s: LogicStep) => `${s.room}: ${s.action}`;

/** The build assistant's game checker (agent I): a read tool that proves the game beatable with no dead states, or shows how it fails. */
export const logicTools: DomainTools<never> = {
  descriptions: {},
  schemas: {},
  summary: () => [],
  reads: [
    {
      name: "checkGame",
      description:
        "Prove the game can be finished and has no dead states (deterministic, the runtime's real rules and physics): beatable, each dead state with the last steps into it and why, and the rooms reachable. Run it after changing game logic, props, rooms or doors.",
      schema: CheckInput,
      run: (project, args) => {
        const parsed = CheckInput.safeParse(args ?? {});
        if (!parsed.success) return { ok: false, error: { code: "invalid", message: parsed.error.message } };
        const r = checkGame(project, parsed.data);
        return {
          ok: true,
          beatable: r.beatable,
          ...(r.hasEnding ? {} : { hasEnding: false }),
          route: r.route?.filter(telling).map(line).slice(0, 30) ?? null,
          deadStates: r.deadStates.slice(0, 5).map((d) => ({ why: d.why, ...(d.fromSave ? { fromSave: true } : {}), lastSteps: d.path.filter(telling).slice(-6).map(line) })),
          ...(r.deadStates.length > 5 ? { moreDeadStates: r.deadStates.length - 5 } : {}),
          reachableRooms: r.reachableRooms,
          ...(r.stats.truncated ? { truncated: true } : {}),
        };
      },
    },
    {
      name: "checkGates",
      description:
        "For each progression connection that needs a movement ability: is the far region reachable without it (it must not be) and with it (it must be)? Gates built only from flags or bosses don't hold; build them as geometry (createChunkRoom gate).",
      schema: z.strictObject({}),
      run: (project) => ({
        ok: true,
        gates: gateChecks(project).map((g) => ({
          ...g,
          verdict: !g.reachableWith ? `the ${g.to} region can't be reached at all` : g.holdsWithout ? "holds" : `doesn't hold: ${g.to} is reachable without ${g.needs.join(" and ")}`,
        })),
      }),
    },
  ],
};
