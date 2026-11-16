import type { ProjectSpec } from "../schema.ts";
import type { Progression } from "./progression.ts";

/**
 * Progression checks: graph searches over regions, gates and items.
 *
 * Sphere 0 is everything reachable from the start with nothing; collecting
 * what's there opens sphere 1, and so on. An ability collected in sphere k
 * is usable from sphere k + 1. Issues never block an edit.
 */

export type ProgressionIssueCode =
  | "no_start"
  | "no_ending"
  | "unbeatable"
  | "unobtainable"
  | "soft_lock"
  | "unreachable_region"
  | "unplaced"
  | "gates_nothing"
  | "front_loaded"
  | "unreachable_beat"
  | "beat_order"
  | "missing_wiki_page";

const ERRORS = new Set<ProgressionIssueCode>(["no_start", "no_ending", "unbeatable", "unobtainable", "soft_lock"]);

export interface ProgressionIssue {
  code: ProgressionIssueCode;
  severity: "error" | "warning";
  message: string;
  /** The progression items it is about, most relevant first. */
  ids: string[];
}

export interface Sphere {
  /** Regions first reachable in this sphere. */
  regions: string[];
  /** Abilities collected in this sphere (usable from the next). */
  abilities: string[];
}

export interface ProgressionReport {
  spheres: Sphere[];
  regionSphere: Record<string, number>;
  abilitySphere: Record<string, number>;
  beatSphere: Record<string, number>;
  finishable: boolean;
  /** Abilities the ending can't be reached without, in sphere order. */
  criticalPath: string[];
  issues: ProgressionIssue[];
}

interface Exploration {
  spheres: (Sphere & { have: Set<string>; reached: Set<string> })[];
  reached: Set<string>;
  have: Set<string>;
}

const hasAll = (have: Set<string>, ids: string[]) => ids.every((id) => have.has(id));

/** Regions reachable from `from` holding `have`. */
function reach(p: Progression, from: string, have: Set<string>): Set<string> {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const at = queue.pop()!;
    for (const c of p.connections) {
      if (!hasAll(have, c.requires)) continue;
      const next = c.from === at ? c.to : !c.oneWay && c.to === at ? c.from : undefined;
      if (next !== undefined && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/** Repeatedly reach and collect, from a region with some abilities, optionally pretending one ability doesn't exist. */
function explore(p: Progression, from: string, start: Set<string> = new Set(), without?: string): Exploration {
  const have = new Set(start);
  const reached = new Set<string>();
  const spheres: Exploration["spheres"] = [];
  for (;;) {
    const regions = reach(p, from, have);
    const gained = p.abilities
      .filter((a) => a.id !== without && !have.has(a.id) && a.obtainedIn && regions.has(a.obtainedIn.regionId) && hasAll(have, a.obtainedIn.requires))
      .map((a) => a.id);
    const fresh = p.regions.map((r) => r.id).filter((r) => regions.has(r) && !reached.has(r));
    spheres.push({ regions: fresh, abilities: gained, have: new Set(have), reached: regions });
    regions.forEach((r) => reached.add(r));
    if (gained.length === 0) return { spheres, reached, have };
    gained.forEach((a) => have.add(a));
  }
}

export function progressionReport(project: ProjectSpec): ProgressionReport {
  const p = project.progression;
  const report: ProgressionReport = { spheres: [], regionSphere: {}, abilitySphere: {}, beatSphere: {}, finishable: false, criticalPath: [], issues: [] };
  if (p.regions.length === 0 && p.abilities.length === 0) return report;

  const issue = (code: ProgressionIssueCode, message: string, ids: string[] = []) =>
    report.issues.push({ code, severity: ERRORS.has(code) ? "error" : "warning", message, ids });
  const name = (id: string) => p.regions.find((r) => r.id === id)?.name ?? p.abilities.find((a) => a.id === id)?.name ?? id;
  const names = (ids: Iterable<string>) => [...ids].map(name).join(", ") || "nothing";

  if (p.start === undefined) issue("no_start", "No start region: choose where the game begins.");
  if (p.ending === undefined) issue("no_ending", "No ending: choose the region whose arrival finishes the game.");

  const run = p.start !== undefined ? explore(p, p.start) : undefined;
  if (run) {
    report.spheres = run.spheres.map(({ regions, abilities }) => ({ regions, abilities }));
    run.spheres.forEach((s, k) => {
      s.regions.forEach((r) => (report.regionSphere[r] = k));
      s.abilities.forEach((a) => (report.abilitySphere[a] = k));
    });
    for (const b of p.beats) {
      const k = run.spheres.findIndex((s) => s.reached.has(b.regionId) && hasAll(s.have, b.requires));
      if (k >= 0) report.beatSphere[b.id] = k;
    }
  }
  const ending = p.ending;
  report.finishable = run !== undefined && ending !== undefined && run.reached.has(ending);

  if (run && ending !== undefined && !report.finishable) {
    issue("unbeatable", `The ending, ${name(ending)}, can't be reached, even with everything the player can collect (${names(run.have)}).`, [ending]);
  }

  if (run && ending !== undefined && report.finishable) {
    // Soft-locks: somewhere reachable with what you hold at sphere k that the ending can't be reached from.
    const flagged = new Set<string>();
    run.spheres.forEach((s, k) => {
      for (const r of s.reached) {
        if (flagged.has(r) || explore(p, r, s.have).reached.has(ending)) continue;
        flagged.add(r);
        const traps = p.connections.filter((c) => c.oneWay && c.to === r).map((c) => c.id);
        issue(
          "soft_lock",
          `Soft-lock: the player can reach ${name(r)} holding ${names(s.have)} (sphere ${k}), but can't get from there to the ending.${traps.length ? " Check the one-way connections into it." : ""}`,
          [r, ...traps],
        );
      }
    });
    for (const a of run.have) {
      if (!explore(p, p.start!, new Set(), a).reached.has(ending)) report.criticalPath.push(a);
    }
    report.criticalPath.sort((a, b) => report.abilitySphere[a]! - report.abilitySphere[b]!);
  }

  for (const a of p.abilities) {
    if (!a.obtainedIn) issue("unplaced", `${a.name} has no location yet.`, [a.id]);
    else if (run && !run.have.has(a.id)) {
      const why = run.reached.has(a.obtainedIn.regionId) ? `its requirements (${names(a.obtainedIn.requires)}) are never met` : `${name(a.obtainedIn.regionId)} is unreachable`;
      issue("unobtainable", `${a.name} can never be collected: ${why}.`, [a.id]);
    }
    const used = p.connections.some((c) => c.requires.includes(a.id)) || p.abilities.some((b) => b.obtainedIn?.requires.includes(a.id));
    if (!used) issue("gates_nothing", `${a.name} doesn't open anything: no connection or item requires it.`, [a.id]);
  }
  if (run) {
    for (const r of p.regions) {
      if (!run.reached.has(r.id) && r.id !== ending) issue("unreachable_region", `${r.name} can't be reached from the start.`, [r.id]);
    }
    const collected = p.abilities.filter((a) => run.have.has(a.id));
    if (collected.length >= 2 && collected.every((a) => report.abilitySphere[a.id] === 0)) {
      issue("front_loaded", "Every ability can be collected without any other: nothing builds on anything else.", collected.map((a) => a.id));
    }
  }

  const pages = new Map(project.wiki.pages.map((page) => [page.id, page]));
  const title = (pageId: string) => pages.get(pageId)?.title ?? pageId;
  if (run) {
    for (const b of p.beats) {
      if (report.beatSphere[b.id] === undefined) issue("unreachable_beat", `Story beat "${title(b.wikiPageId)}" in ${name(b.regionId)} can never happen.`, [b.id, b.regionId]);
    }
    // Beats whose wiki `order` says later, but which the structure allows earlier.
    const ordered = p.beats
      .map((b) => ({ b, order: Number(pages.get(b.wikiPageId)?.fields.order), sphere: report.beatSphere[b.id] }))
      .filter((x): x is { b: (typeof p.beats)[number]; order: number; sphere: number } => Number.isFinite(x.order) && x.sphere !== undefined);
    for (const later of ordered) {
      const earlier = ordered.filter((x) => x.order < later.order && x.sphere > later.sphere).sort((x, y) => y.sphere - x.sphere)[0];
      if (earlier) {
        issue(
          "beat_order",
          `Story beat "${title(later.b.wikiPageId)}" (order ${later.order}) is reachable in sphere ${later.sphere}, before "${title(earlier.b.wikiPageId)}" (order ${earlier.order}, sphere ${earlier.sphere}).`,
          [later.b.id, earlier.b.id],
        );
      }
    }
  }
  for (const item of [...p.regions, ...p.abilities, ...p.beats]) {
    if (item.wikiPageId !== undefined && !pages.has(item.wikiPageId)) {
      const label = "name" in item ? item.name : `Story beat ${item.id}`;
      issue("missing_wiki_page", `${label} links to the wiki page "${item.wikiPageId}", which doesn't exist.`, [item.id]);
    }
  }

  report.issues.sort((a, b) => Number(b.severity === "error") - Number(a.severity === "error"));
  return report;
}
