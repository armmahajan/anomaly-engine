import type { ProjectSpec } from "../schema.ts";
import { lintProject } from "../lint.ts";
import { progressionReport } from "../progression/report.ts";
import { checkGame, type CheckResult } from "../world/logic/check.ts";
import { abilityChecks, gateChecks } from "../world/logic/gates.ts";
import type { ArchitectStage } from "./plan.ts";
import { gateLeaks, planIssues } from "./planCheck.ts";
import type { StageIssue, StageOutcome } from "./stages.ts";

/** Which stage fixes a lint warning (by code); anything else goes back to population. */
const LINT_STAGE: Record<string, ArchitectStage> = {
  unstandable_platform: "geometry",
  spawn_inside_platform: "population",
  spawn_out_of_bounds: "population",
  unplaced_character: "cast",
  unreachable_state: "cast",
  endless_state: "cast",
  movement_mismatch: "cast",
  dressing_out_of_date: "art",
};

/** Lint codes that never fail a build (advisory: the creator's call). */
const ADVISORY = new Set(["dressing_out_of_date", "fairness", "unfair_attack", "unplaced_character"]);

/** The checker's state budget for verify: big games (25-30 rooms, several abilities) need a few hundred thousand. */
export const VERIFY_MAX_STATES = 600_000;

class TruncatedCheck extends Error {}

export interface Verdict {
  beatable: boolean;
  deadStates: number;
  gatesHold: boolean;
  abilitiesNeeded: boolean;
  lint: string[];
  check: CheckResult | null;
}

/**
 * The verify stage: prove the built game. Issues carry the stage that should fix
 * them (as `stage`), so a run can send each failure back where it came from.
 * Doesn't change the project.
 */
export function verifyStage(project: ProjectSpec): StageOutcome & { verdict: Verdict } {
  const issues: StageIssue[] = [];
  const roomOf = (path: string) => {
    const m = /^world\.rooms\.(\d+)/.exec(path);
    return m ? project.world.rooms[Number(m[1])]?.id : undefined;
  };
  // Problems in the plan itself come first: the built game can't be right while the plan isn't.
  for (const i of planIssues(project).issues) {
    if (["gate-bypass-route", "gate-bypass-link", "unguarded-grant", "ungranted", "missing-join"].includes(i.code)) issues.push(i);
  }
  const lint = lintProject(project);
  for (const w of lint) {
    if (ADVISORY.has(w.code)) continue;
    const roomId = roomOf(w.path);
    issues.push({ stage: LINT_STAGE[w.code] ?? "population", code: `lint:${w.code}`, message: w.message, ...(roomId ? { roomId } : {}) });
  }

  let check: CheckResult | null = null;
  let gatesHold = true;
  let abilitiesNeeded = true;
  try {
    check = checkGame(project, { maxStates: VERIFY_MAX_STATES });
    if (check.stats.truncated) {
      // A search cut short proves nothing either way: say so instead of reporting a false "not beatable".
      issues.push({ stage: "verify", code: "check-truncated", message: `the game has more than ${VERIFY_MAX_STATES} states to check; the proof didn't finish` });
      throw new TruncatedCheck();
    }
    if (!check.hasEnding) issues.push({ stage: "population", code: "no-ending", message: "nothing runs endGame" });
    else if (!check.beatable) issues.push({ stage: "geometry", code: "not-beatable", message: "the ending can't be reached from the start" });
    for (const d of check.deadStates.slice(0, 5)) {
      const last = d.path.at(-1);
      issues.push({ stage: "population", code: "dead-state", message: `${d.fromSave ? "a Continue " : ""}dead state: ${d.why}`, ...(last ? { roomId: last.room } : {}) });
    }
    // A gate the plan's own links lead around is the plan's to fix; otherwise the rooms leak.
    const planLeaks = new Set(gateLeaks(project).map((l) => l.connection));
    for (const g of gateChecks(project, check, VERIFY_MAX_STATES)) {
      if (!g.holdsWithout) {
        gatesHold = false;
        issues.push({ stage: planLeaks.has(g.connection) ? "plan" : "geometry", code: "gate-bypassed", message: `the gate ${g.connection} (${g.from} -> ${g.to}) can be passed without ${g.needs.join(", ")}`, linkId: g.connection });
      }
      if (!g.reachableWith) issues.push({ stage: "geometry", code: "gate-closed", message: `${g.to} can't be reached through ${g.connection} even with ${g.needs.join(", ")}`, linkId: g.connection });
    }
    for (const a of abilityChecks(project, progressionReport(project).criticalPath, VERIFY_MAX_STATES)) {
      if (!a.needed) {
        abilitiesNeeded = false;
        issues.push({ stage: "geometry", code: "ability-unneeded", message: `the ending can be reached without ${a.ability} (${a.mechanic}): no gate needs it` });
      }
    }
  } catch (e) {
    if (!(e instanceof TruncatedCheck)) issues.push({ stage: "verify", code: "check-crashed", message: e instanceof Error ? e.message : String(e) });
  }
  const verdict: Verdict = {
    beatable: check?.beatable ?? false,
    deadStates: check?.deadStates.length ?? 0,
    gatesHold,
    abilitiesNeeded,
    lint: lint.filter((w) => !ADVISORY.has(w.code)).map((w) => `${w.code}: ${w.message}`),
    check,
  };
  const ok = issues.length === 0;
  const summary = ok
    ? `verified: beatable, no dead states${check ? ` (${check.stats.states} states, ${check.stats.ms} ms)` : ""}, gates hold, lint clean`
    : `${issues.length} issue(s): ${[...new Set(issues.map((i) => i.code))].join(", ")}`;
  return { project, issues, summary, verdict };
}
