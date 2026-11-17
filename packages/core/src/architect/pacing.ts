import type { ProjectSpec } from "../schema.ts";
import { gridSize } from "../world/tiles.ts";
import type { CheckResult } from "../world/logic/check.ts";
import { checkGame } from "../world/logic/check.ts";
import type { StageIssue, StageOutcome } from "./stages.ts";

/**
 * A deterministic play-time estimate for a first playthrough, from the proven
 * route (rooms in the order the checker's route visits them, backtracking
 * included), the rooms off the route a player explores once, and the fights.
 * Coarse on purpose: it steers the plan's size toward the target, it isn't a
 * prediction to the minute. Constants are named so they can be calibrated
 * against real playthroughs.
 */
export const PACING = {
  /** Seconds per room crossing per px of room (width + half the height), relative to run speed: winding paths, jumps, looking around. */
  windingFactor: 2.2,
  /** Seconds spent per sword hit needed (dodging between swings). */
  secondsPerHit: 1.1,
  /** Extra seconds per fight (approach, reading the enemy). */
  secondsPerFight: 2,
  /** Enemies with a health bar fight in patterns: this many times longer. */
  guardianFactor: 3,
  /** Seconds per message screen read. */
  secondsPerModal: 4,
  /** Deaths, retries and getting lost on a first playthrough. */
  firstPlayFactor: 1.5,
} as const;

export interface PacingEstimate {
  minutes: number;
  traversalSeconds: number;
  fightSeconds: number;
  readingSeconds: number;
  roomVisits: number;
  fights: number;
}

/** The checker's budget for the route the estimate walks (as verify's: a cut-short search has no route). */
const PACING_MAX_STATES = 600_000;

export function estimatePlayTime(project: ProjectSpec, check: CheckResult = checkGame(project, { maxStates: PACING_MAX_STATES })): PacingEstimate {
  const player = project.characters.find((c) => c.kind === "player");
  const runSpeed = player?.kind === "player" ? player.stats.runSpeed : 320;
  const damage = player?.kind === "player" ? Math.max(1, player.stats.attackDamage) : 1;
  const rooms = new Map(project.world.rooms.map((r) => [r.id, r]));
  const crossing = (id: string) => {
    const room = rooms.get(id);
    if (!room) return 0;
    const { width, height } = gridSize(room.grid);
    return ((width + height / 2) / runSpeed) * PACING.windingFactor;
  };

  // Rooms in route order (each entry into a room is a visit), then every other reachable room once.
  const visits: string[] = [];
  for (const step of check.route ?? []) if (visits.at(-1) !== step.room) visits.push(step.room);
  const offRoute = check.reachableRooms.filter((id) => !visits.includes(id));
  const traversalSeconds = [...visits, ...offRoute].reduce((sum, id) => sum + crossing(id), 0);

  // Every enemy in a reachable room is fought once.
  const characters = new Map(project.characters.map((c) => [c.id, c]));
  let fightSeconds = 0;
  let fights = 0;
  for (const id of check.reachableRooms) {
    for (const spawn of rooms.get(id)?.spawns ?? []) {
      const c = characters.get(spawn.characterId);
      if (c?.kind !== "enemy") continue;
      fights++;
      const hits = Math.ceil(c.stats.health / damage);
      fightSeconds += (hits * PACING.secondsPerHit + PACING.secondsPerFight) * (spawn.healthBar ? PACING.guardianFactor : 1);
    }
  }
  const readingSeconds = project.world.modals.length * PACING.secondsPerModal;
  const minutes = ((traversalSeconds + fightSeconds + readingSeconds) * PACING.firstPlayFactor) / 60;
  return { minutes: Math.round(minutes * 10) / 10, traversalSeconds: Math.round(traversalSeconds), fightSeconds: Math.round(fightSeconds), readingSeconds, roomVisits: visits.length, fights };
}

/** The pacing stage: estimate, and if the game is outside the plan's target, say by how much (the run grows or trims the plan). */
export function pacingStage(project: ProjectSpec, check?: CheckResult): StageOutcome & { estimate: PacingEstimate } {
  const estimate = estimatePlayTime(project, check);
  const [lo, hi] = project.architect.target.minutes;
  const issues: StageIssue[] = [];
  const rooms = project.architect.rooms.length;
  const [few, many] = project.architect.target.rooms;
  const room = (more: boolean) =>
    more
      ? rooms >= many
        ? `the plan already has ${rooms} rooms (target ${few}–${many}): make rooms larger or add ordinary enemies (not guardians) instead of rooms`
        : `add up to ${many - rooms} room(s) or more ordinary enemies, not guardians (stay within ${many} rooms)`
      : rooms <= few
        ? `the plan has ${rooms} rooms (target ${few}–${many}): make rooms smaller or fights shorter instead of cutting rooms`
        : `cut up to ${rooms - few} room(s) or some fights (keep at least ${few} rooms)`;
  if (estimate.minutes < lo) issues.push({ stage: "plan", code: "too-short", message: `about ${estimate.minutes} min, under the ${lo}–${hi} min target: ${room(true)}` });
  if (estimate.minutes > hi) issues.push({ stage: "plan", code: "too-long", message: `about ${estimate.minutes} min, over the ${lo}–${hi} min target: ${room(false)}` });
  const summary = `about ${estimate.minutes} min (${estimate.roomVisits} room visits, ${estimate.fights} fights; target ${lo}–${hi})`;
  return { project, issues, summary, estimate };
}
