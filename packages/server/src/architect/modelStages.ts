import { planIssues, previewOwnsPlan, seedPlan, type ProjectSpec } from "@anomaly/core";
import { architectAgent, buildAgent, type AgentProfile, type TurnRunner } from "@anomaly/agent";
import { privateTurn } from "../agentTurn.ts";
import type { StageRunContext, StageRunners } from "./service.ts";

/**
 * The Architect's model stages: the plan (the Architect agent shapes the plan from
 * the design and the creator's notes, starting from the plan seeded from the
 * progression) and the cast (the build assistant creates the enemy characters the
 * plan names; difficulty scales them after population). Each runs one agent turn on
 * a private copy of the project; the run commits the result as one revision.
 */
export function modelStageRunners(runner: TurnRunner): Pick<StageRunners, "plan" | "cast"> {
  return {
    plan: async (ctx) => {
      let project = ctx.project;
      // The studio's live preview (seeded from the progression, untouched since) is a fresh start too.
      const fresh = project.architect.rooms.length === 0 || previewOwnsPlan(project);
      if (project.architect.rooms.length === 0) project = { ...project, architect: seedPlan(project) };
      const feedback = ctx.feedback?.length ? `\nThe last build reported: ${ctx.feedback.join("; ")}. Change the plan to fix that.` : "";
      const message = fresh
        ? `Plan the game world now. The plan has been seeded from the progression; shape it into a good world for this game: room counts and sizes for the play-time target, terrain, contents (guardians, pickups, save points, enemies), names and a short note per room, and links (with loops and shortcuts that never bypass a gate). Follow the creator's notes. Don't queue a build run. Finish with checkPlan clean.${feedback}`
        : `Review the plan for the build: keep everything the creator set (their notes, edits and pinned rooms), fill what's missing and fix every checkPlan issue. Don't queue a build run.${feedback}`;
      const after = await agentTurn(runner, architectAgent, project, message, ctx);
      const { issues } = planIssues(after.project);
      return {
        project: after.project,
        issues,
        // A game without a progression (hand-built) has nothing to plan: an empty plan doesn't stop the run.
        blocking: after.project.progression.regions.length > 0 && issues.some((i) => ["no-rooms", "start", "ending", "unlinked", "missing-join", "ungranted", "gate-bypass-route", "gate-bypass-link", "unguarded-grant"].includes(i.code)),
        summary: `planned ${after.project.architect.rooms.length} rooms, ${after.project.architect.links.length} links${issues.length ? `; ${issues.length} plan issue(s)` : ""}${after.reply ? ` — ${after.reply.slice(0, 300)}` : ""}`,
      };
    },
    cast: async (ctx) => {
      const { toCast } = planIssues(ctx.project);
      let project = ctx.project;
      let reply = "";
      if (toCast.length > 0) {
        const where = (id: string) =>
          [...new Set(project.architect.rooms.filter((r) => r.contents.some((c) => c.kind === "enemy" && c.characterId === id)).map((r) => r.regionId))].join(", ");
        const guardians = new Set(project.architect.rooms.flatMap((r) => r.contents.flatMap((c) => (c.kind === "enemy" && c.lockRoom ? [c.characterId] : []))));
        const list = toCast.map((id) => `${id} (in ${where(id)}${guardians.has(id) ? "; a guardian that locks its room and is fought in a long pattern" : ""})`).join("; ");
        const message = `Create these enemy characters for the world plan, with ids exactly as given: ${list}. Read their wiki pages (and the regions' pages) and give each a fitting size, stats and a behavior built from the primitives; guardians get several attacks with clear windups and phases. Write each at first-region strength: stats rise automatically in deeper regions. Don't add spawns or rooms: the Architect places them. Don't queue art.`;
        const after = await agentTurn(runner, buildAgent, project, message, ctx);
        project = after.project;
        reply = after.reply;
      }
      const missing = planIssues(project).toCast;
      return {
        project,
        issues: missing.map((id) => ({ stage: "cast" as const, code: "uncast", message: `enemy "${id}" wasn't created` })),
        blocking: missing.length > 0,
        summary: toCast.length ? `created ${toCast.length - missing.length} of ${toCast.length} enemies${reply ? ` — ${reply.slice(0, 200)}` : ""}` : "every enemy the plan names exists",
      };
    },
  };
}

/** One agent turn on a private copy of the project (see ../agentTurn.ts). */
async function agentTurn(runner: TurnRunner, agent: AgentProfile, project: ProjectSpec, message: string, ctx: StageRunContext): Promise<{ project: ProjectSpec; reply: string }> {
  return privateTurn(runner, agent, project, message, ctx);
}
