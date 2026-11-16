import { z } from "zod";
import { Id } from "../common.ts";
import { PageStatus } from "../wiki/wiki.ts";

/**
 * Progression: the game's structure. Regions joined by connections, gated
 * by abilities and key items, each found somewhere. Pure design data: the
 * runtime doesn't read it yet. Checked by ./report.ts.
 */

export const MECHANICS = {
  dash: "A burst of horizontal speed; crosses wide gaps.",
  double_jump: "A second jump in mid-air; reaches higher ledges.",
  wall_jump: "Cling to and jump off walls; climbs vertical shafts.",
  glide: "Fall slowly; crosses very long gaps and updrafts.",
  swim: "Move through deep water.",
  ground_pound: "Slam downward; breaks floors.",
  key: "No mechanic: a key, story item or boss token that opens something.",
} as const;
export const Mechanic = z.enum(Object.keys(MECHANICS) as [keyof typeof MECHANICS, ...(keyof typeof MECHANICS)[]]);
export type Mechanic = z.infer<typeof Mechanic>;

export const RewardSource = z.enum(["boss", "shrine", "npc", "hidden", "pickup"]);

const WikiPageId = Id.describe("Id of the wiki page that describes it.");
export const Requires = z
  .array(Id)
  .max(8)
  .default([])
  .describe("Ability ids the player needs, all of them. Use two connections for either/or.");

export const Ability = z.strictObject({
  id: Id,
  name: z.string().min(1).max(80),
  mechanic: Mechanic.describe(Object.entries(MECHANICS).map(([k, v]) => `${k}: ${v}`).join(" ")),
  obtainedIn: z
    .strictObject({
      regionId: Id,
      source: RewardSource,
      requires: Requires.describe("Abilities needed to get it inside the region (e.g. hidden behind a dash gap)."),
    })
    .optional()
    .describe("Where the player gets it. Omit while undecided."),
  wikiPageId: WikiPageId.optional(),
  status: PageStatus,
});
export type Ability = z.infer<typeof Ability>;

export const Region = z.strictObject({
  id: Id,
  name: z.string().min(1).max(80),
  rooms: z.number().int().min(1).max(80).default(8).describe("Rough size in rooms."),
  enemies: z.array(Id).max(24).default([]).describe("Ids of enemy characters met here."),
  boss: Id.optional().describe("Id of the enemy character that is this region's boss."),
  wikiPageId: WikiPageId.optional().describe("Id of the wiki place page for this region."),
  status: PageStatus,
});
export type Region = z.infer<typeof Region>;

export const Connection = z.strictObject({
  id: Id,
  from: Id,
  to: Id,
  oneWay: z.boolean().default(false).describe("Only from -> to (a drop, a collapsing bridge)."),
  requires: Requires,
  status: PageStatus,
});
export type Connection = z.infer<typeof Connection>;

export const StoryBeat = z.strictObject({
  id: Id,
  wikiPageId: Id.describe("The wiki story page for this beat."),
  regionId: Id.describe("Where it happens."),
  requires: Requires.describe("Abilities the player has by then."),
  status: PageStatus,
});
export type StoryBeat = z.infer<typeof StoryBeat>;

export const Progression = z.strictObject({
  start: Id.optional().describe("Region where the game starts."),
  ending: Id.optional().describe("Region where the game ends; reaching it finishes the game."),
  abilities: z.array(Ability).max(64),
  regions: z.array(Region).max(64),
  connections: z.array(Connection).max(256),
  beats: z.array(StoryBeat).max(64),
});
export type Progression = z.infer<typeof Progression>;

export const defaultProgression = (): Progression => ({ abilities: [], regions: [], connections: [], beats: [] });

export type ProgressionItem =
  | { kind: "ability"; item: Ability }
  | { kind: "region"; item: Region }
  | { kind: "connection"; item: Connection }
  | { kind: "beat"; item: StoryBeat };

/** Ids are unique across all four lists, so one id names one item. */
export function findProgressionItem(progression: Progression, id: string): ProgressionItem | undefined {
  const ability = progression.abilities.find((a) => a.id === id);
  if (ability) return { kind: "ability", item: ability };
  const region = progression.regions.find((r) => r.id === id);
  if (region) return { kind: "region", item: region };
  const connection = progression.connections.find((c) => c.id === id);
  if (connection) return { kind: "connection", item: connection };
  const beat = progression.beats.find((b) => b.id === id);
  if (beat) return { kind: "beat", item: beat };
  return undefined;
}

export const progressionIds = (p: Progression) => [...p.abilities, ...p.regions, ...p.connections, ...p.beats].map((i) => i.id);

/** Reference checks, run as part of ProjectSpec validation. */
export function progressionIssues(progression: Progression, characters: { id: string; kind: string }[]): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  const seen = new Set<string>();
  const lists = ["abilities", "regions", "connections", "beats"] as const;
  for (const list of lists) {
    progression[list].forEach((item, i) => {
      if (seen.has(item.id)) issues.push({ path: ["progression", list, i, "id"], message: `duplicate progression id "${item.id}"` });
      seen.add(item.id);
    });
  }
  const regions = new Set(progression.regions.map((r) => r.id));
  const abilities = new Set(progression.abilities.map((a) => a.id));
  const enemies = new Set(characters.filter((c) => c.kind === "enemy").map((c) => c.id));
  const known = (ids: Set<string>) => (ids.size ? ` (known: ${[...ids].join(", ")})` : " (none exist)");
  const region = (id: string | undefined, path: (string | number)[]) => {
    if (id !== undefined && !regions.has(id)) issues.push({ path, message: `unknown region "${id}"${known(regions)}` });
  };
  const requires = (ids: string[], path: (string | number)[]) =>
    ids.forEach((id, i) => {
      if (!abilities.has(id)) issues.push({ path: [...path, i], message: `unknown ability "${id}"${known(abilities)}` });
    });
  const enemy = (id: string | undefined, path: (string | number)[]) => {
    if (id !== undefined && !enemies.has(id)) issues.push({ path, message: `unknown enemy character "${id}"${known(enemies)}` });
  };

  region(progression.start, ["progression", "start"]);
  region(progression.ending, ["progression", "ending"]);
  progression.abilities.forEach((a, i) => {
    if (!a.obtainedIn) return;
    region(a.obtainedIn.regionId, ["progression", "abilities", i, "obtainedIn", "regionId"]);
    requires(a.obtainedIn.requires, ["progression", "abilities", i, "obtainedIn", "requires"]);
    if (a.obtainedIn.requires.includes(a.id)) issues.push({ path: ["progression", "abilities", i, "obtainedIn", "requires"], message: `"${a.id}" can't require itself` });
  });
  progression.regions.forEach((r, i) => {
    r.enemies.forEach((e, j) => enemy(e, ["progression", "regions", i, "enemies", j]));
    enemy(r.boss, ["progression", "regions", i, "boss"]);
  });
  progression.connections.forEach((c, i) => {
    region(c.from, ["progression", "connections", i, "from"]);
    region(c.to, ["progression", "connections", i, "to"]);
    if (c.from === c.to) issues.push({ path: ["progression", "connections", i, "to"], message: "a connection joins two different regions" });
    requires(c.requires, ["progression", "connections", i, "requires"]);
  });
  progression.beats.forEach((b, i) => {
    region(b.regionId, ["progression", "beats", i, "regionId"]);
    requires(b.requires, ["progression", "beats", i, "requires"]);
  });
  return issues;
}
