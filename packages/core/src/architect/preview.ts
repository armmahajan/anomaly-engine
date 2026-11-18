import { ProjectSpec } from "../schema.ts";
import { ARCHITECT_STAGES, type ArchitectPlan, type ArchitectStage, type StageStatus } from "./plan.ts";
import { seedPlan } from "./seedPlan.ts";
import { geometryStage, layoutStage } from "./geometry/index.ts";
import { populationStage } from "./population/index.ts";
import type { StageIssue, StageOutcome } from "./stages.ts";

/**
 * The live preview of the world: while the director (or the creator) designs the
 * progression, the studio builds rooms for it with the Architect's code stages and
 * no model and no art (the plan seeded from the progression -> layout -> geometry ->
 * population), so the world takes shape as it is designed.
 *
 * The preview owns the plan only until someone else shapes it. `architect.preview`
 * records fingerprints of what the preview built (the progression it followed, the
 * plan with its stage statuses, and the rooms it made); any difference means the
 * creator or the Architect took over: a plan edit, a pinned room, an Architect run
 * (it writes stage statuses), an edited or dressed room. From then on the preview
 * never rebuilds; a progression change marks the Architect's stages stale instead.
 *
 * Not built by the preview: difficulty variants (new characters) and the screens
 * stage (a title on gameStarted and the map are game-wide), and the creator's
 * playtest spot is kept. The Architect's run does all of that.
 */

export const PREVIEW_STAGES = ["layout", "geometry", "population"] as const satisfies readonly ArchitectStage[];
export const PREVIEW_PREFIX = "preview: ";

/** FNV-1a, 32 bits, of the value's JSON with sorted keys, as hex: enough to tell versions of a document apart. */
export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v)) ?? "";
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * What the preview's rooms follow: the progression's structure (not whether items are
 * draft or canon) and which of its enemies exist. Tuning the player's movement isn't a
 * progression change (the Architect's verify stage proves the rooms for it).
 */
export function progressionFingerprint(project: ProjectSpec): string {
  const p = project.progression;
  const enemies = new Set(project.characters.filter((c) => c.kind === "enemy").map((c) => c.id));
  return fingerprint({
    start: p.start ?? null,
    ending: p.ending ?? null,
    regions: p.regions.map((r) => [r.id, r.name, r.rooms, r.enemies.filter((e) => enemies.has(e)), r.boss && enemies.has(r.boss) ? r.boss : null]),
    abilities: p.abilities.map((a) => [a.id, a.name, a.mechanic, a.obtainedIn ?? null]),
    connections: p.connections.map((c) => [c.id, c.from, c.to, c.oneWay, c.requires]),
  });
}

export const planFingerprint = (plan: ArchitectPlan) => fingerprint({ rooms: plan.rooms, links: plan.links, stages: plan.stages });

/** The world rooms the plan builds, as they are now. */
export const planRoomsFingerprint = (project: ProjectSpec) => {
  const ids = new Set(project.architect.rooms.map((r) => r.id));
  return fingerprint(project.world.rooms.filter((r) => ids.has(r.id)));
};

/** The progression has enough for rooms: regions, a start, and a player to size them by. */
export function canPreview(project: ProjectSpec): boolean {
  return project.progression.regions.length > 0 && project.progression.start !== undefined && project.characters.some((c) => c.kind === "player");
}

/**
 * The preview may (re)build the plan and its rooms: the plan is empty and nobody has
 * started on the world's regions (no rooms in regions, no stage run), or it is exactly
 * what the preview last built.
 */
export function previewOwnsPlan(project: ProjectSpec): boolean {
  const plan = project.architect;
  if (plan.rooms.length === 0 && plan.links.length === 0) {
    return Object.keys(plan.stages).length === 0 && !project.world.rooms.some((r) => r.regionId !== undefined);
  }
  const preview = plan.preview;
  if (!preview || plan.rooms.some((r) => r.pinned)) return false;
  if (planFingerprint(plan) !== preview.plan || planRoomsFingerprint(project) !== preview.rooms) return false;
  // Rooms in regions that the plan doesn't build are someone else's world.
  const ids = new Set(plan.rooms.map((r) => r.id));
  return !project.world.rooms.some((r) => r.regionId !== undefined && !ids.has(r.id));
}

export interface PreviewOutcome {
  project: ProjectSpec;
  issues: StageIssue[];
  summary: string;
}

/**
 * Build the preview from the progression (pure; seconds for a few dozen rooms, so the
 * server runs it off the main thread). The rooms of the plan it replaces go first, so
 * they don't hold their old places on the map.
 */
export function buildPreview(project: ProjectSpec): PreviewOutcome {
  const at = new Date().toISOString();
  const old = new Set(project.architect.rooms.map((r) => r.id));
  const cleared: ProjectSpec = {
    ...project,
    architect: { ...project.architect, rooms: [], links: [], stages: {} },
    world: { ...project.world, rooms: project.world.rooms.filter((r) => !old.has(r.id)) },
  };
  const plan = seedPlan(cleared);
  let current: ProjectSpec = { ...cleared, architect: { ...plan, stages: {} } };
  const issues: StageIssue[] = [];
  const stages: Partial<Record<ArchitectStage, StageStatus>> = {};
  const steps: [ArchitectStage, (p: ProjectSpec) => StageOutcome][] = [
    ["layout", (p) => layoutStage(p)],
    ["geometry", (p) => geometryStage(p)],
    ["population", (p) => populationStage(p)],
  ];
  for (const [stage, run] of steps) {
    let out: StageOutcome;
    try {
      out = run(current);
    } catch (e) {
      out = { project: current, issues: [{ stage, code: "crashed", message: e instanceof Error ? e.message : String(e) }], summary: `${stage} failed` };
    }
    current = out.project;
    const own = out.issues.filter((i) => i.stage === stage);
    issues.push(...out.issues);
    stages[stage] = { status: own.length ? "failed" : "done", summary: `${PREVIEW_PREFIX}${out.summary}`.slice(0, 2000), at };
  }
  // The creator's playtest spot stays where it was (the preview's start is the world start).
  const playtest = project.world.playtest && current.world.rooms.some((r) => r.id === project.world.playtest!.room) ? project.world.playtest : current.world.playtest;
  current = { ...current, world: { ...current.world, playtest }, architect: { ...current.architect, stages } };
  current = withPreviewMark(current, progressionFingerprint(project));
  const built = current.world.rooms.filter((r) => current.architect.rooms.some((p) => p.id === r.id)).length;
  return {
    project: current,
    issues,
    summary: `built ${built} of ${current.architect.rooms.length} room(s) from the progression${issues.length ? ` (${issues.length} issue(s))` : ""}`,
  };
}

/** Record what the preview built, fingerprinted as the store will save it (schema defaults filled in). */
function withPreviewMark(project: ProjectSpec, progression: string): ProjectSpec {
  const parsed = ProjectSpec.safeParse(project);
  const saved = parsed.success ? parsed.data : project;
  return { ...saved, architect: { ...saved.architect, preview: { progression, plan: planFingerprint(saved.architect), rooms: planRoomsFingerprint(saved) } } };
}

/**
 * Put a preview built from an earlier snapshot onto the project as it is now: the plan
 * and the plan's rooms come from the preview, everything else (other rooms, the cast,
 * the wiki, art) stays as it is now. Null when the preview no longer applies: someone
 * took over the plan meanwhile, or the progression changed again.
 */
export function applyPreview(current: ProjectSpec, built: ProjectSpec): ProjectSpec | null {
  const mark = built.architect.preview;
  if (!mark || !previewOwnsPlan(current) || progressionFingerprint(current) !== mark.progression) return null;
  const old = new Set(current.architect.rooms.map((r) => r.id));
  const ids = new Set(built.architect.rooms.map((r) => r.id));
  const rooms = [...current.world.rooms.filter((r) => !old.has(r.id) && !ids.has(r.id)), ...built.world.rooms.filter((r) => ids.has(r.id))];
  const exists = (room: string | undefined) => room !== undefined && rooms.some((r) => r.id === room);
  const missing = <T extends { id: string }>(now: T[], extra: T[]) => [...now, ...extra.filter((x) => !now.some((n) => n.id === x.id))];
  const start = built.world.start ?? (exists(current.world.start?.room) ? current.world.start : null);
  const playtest = exists(current.world.playtest?.room) ? current.world.playtest : exists(built.world.playtest?.room) ? built.world.playtest : null;
  const next: ProjectSpec = {
    ...current,
    characters: missing(current.characters, built.characters),
    world: {
      ...current.world,
      rooms,
      start,
      playtest,
      modals: missing(current.world.modals, built.world.modals),
      items: missing(current.world.items, built.world.items),
    },
    architect: { ...current.architect, rooms: built.architect.rooms, links: built.architect.links, stages: built.architect.stages },
  };
  // The fingerprints of what landed (other rooms don't count; the plan's are the preview's own).
  return withPreviewMark(next, mark.progression);
}

/** Stages that are done become stale (the progression moved on since they ran); null when none were done. */
export function markStagesStale(project: ProjectSpec): ProjectSpec | null {
  const stages = { ...project.architect.stages };
  let changed = false;
  for (const stage of ARCHITECT_STAGES) {
    const s = stages[stage];
    if (s?.status === "done") {
      stages[stage] = { ...s, status: "stale" };
      changed = true;
    }
  }
  return changed ? { ...project, architect: { ...project.architect, stages } } : null;
}
