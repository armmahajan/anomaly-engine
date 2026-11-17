import { describe, expect, it } from "vitest";
import { estimatePlayTime, fixtureReferenceProject, fixtureSliceProject, pacingStage, PACING, planIssues, ProjectSpec, seedPlan, type ArchitectPlan } from "../src/index.ts";

const withPlan = (edit: (plan: ArchitectPlan) => ArchitectPlan) => {
  const base = fixtureReferenceProject();
  return ProjectSpec.parse({ ...base, architect: edit(seedPlan(base)) });
};
const codes = (project: ProjectSpec) => planIssues(project).issues.map((i) => i.code);

describe("plan checks", () => {
  it("a seeded plan is clean", () => {
    expect(planIssues(withPlan((p) => p))).toEqual({ issues: [], toCast: [] });
  });

  it("catch a missing start or ending, an unlinked room, an ability given nowhere or twice, a missing or ungated region join", () => {
    expect(codes(withPlan((p) => ({ ...p, rooms: p.rooms.map((r) => ({ ...r, contents: r.contents.filter((c) => c.kind !== "start") })) })))).toContain("start");
    expect(codes(withPlan((p) => ({ ...p, rooms: p.rooms.map((r) => ({ ...r, contents: r.contents.filter((c) => c.kind !== "ending") })) })))).toContain("ending");
    const lonely = withPlan((p) => ({ ...p, rooms: [...p.rooms, { ...p.rooms[0]!, id: "lonely", contents: [] }] }));
    expect(planIssues(lonely).issues).toContainEqual(expect.objectContaining({ code: "unlinked", roomId: "lonely" }));
    const noGrant = withPlan((p) => ({ ...p, rooms: p.rooms.map((r) => ({ ...r, contents: r.contents.filter((c) => !(c.kind === "pickup" && c.grants === "hatch_key")) })) }));
    expect(codes(noGrant)).toContain("ungranted");
    const twice = withPlan((p) => ({ ...p, rooms: p.rooms.map((r, i) => (i === 0 ? { ...r, contents: [...r.contents, { kind: "pickup" as const, grants: "hatch_key" }] } : r)) }));
    expect(codes(twice)).toContain("granted-twice");
    const open = withPlan((p) => ({ ...p, links: p.links.map((l) => ({ ...l, requires: [] })) }));
    expect(codes(open)).toEqual(expect.arrayContaining(["ungated-join", "gate-bypass-link"]));
    const cut = withPlan((p) => ({ ...p, links: p.links.filter((l) => l.id !== "up_to_summit") }));
    expect(codes(cut)).toEqual(expect.arrayContaining(["missing-join", "unlinked"]));
  });

  it("finds routes around a gate: a gated shortcut back is open from its b side; a one-way shortcut is fine", () => {
    // The reference progression: undercroft -(hatch_key)-> spire <-(double_jump)-> summit.
    const plan = (extra: object) => withPlan((p) => ({ ...p, links: [...p.links, extra as ArchitectPlan["links"][number]] }));
    const summit = (p: ProjectSpec) => p.architect.rooms.find((r) => r.regionId === "summit")!.id;
    const spire = (p: ProjectSpec) => p.architect.rooms.find((r) => r.regionId === "spire")!.id;
    const base = withPlan((x) => x);
    // A "shortcut" from the summit back to the spire, gated a (summit) -> b (spire): from the spire it's open.
    const leaky = plan({ id: "back", a: { room: summit(base) }, b: { room: spire(base) }, requires: ["double_jump"], oneWay: false });
    expect(planIssues(leaky).issues).toContainEqual(expect.objectContaining({ code: "gate-bypass-route", roomId: summit(base) }));
    // The same shortcut one-way from the summit down to the spire is fine.
    const oneWay = plan({ id: "back", a: { room: summit(base) }, b: { room: spire(base) }, requires: [], oneWay: true });
    expect(codes(oneWay)).not.toContain("gate-bypass-route");
    // An either/or route the progression itself designs isn't a leak.
    const either = ProjectSpec.parse({
      ...leaky,
      progression: { ...leaky.progression, connections: [...leaky.progression.connections, { id: "climb", from: "spire", to: "summit", requires: [], oneWay: false, status: "draft" }] },
    });
    expect(codes(either)).not.toContain("gate-bypass-route");
  });

  it("lists enemies the cast stage must create, and cramped arenas", () => {
    const project = withPlan((p) => ({
      ...p,
      rooms: p.rooms.map((r, i) => (i === 1 ? { ...r, terrain: { ...r.terrain, open: 0.1 }, contents: [...r.contents, { kind: "enemy" as const, characterId: "moth", count: 1, lockRoom: true, grants: [], healthBar: true }] } : r)),
    }));
    const { issues, toCast } = planIssues(project);
    expect(toCast).toEqual(["moth"]);
    expect(issues).toContainEqual(expect.objectContaining({ code: "cramped-arena", roomId: project.architect.rooms[1]!.id }));
  });
});

describe("pacing", () => {
  it("estimates from the route, exploration and fights, and grows with the game", () => {
    const slice = estimatePlayTime(fixtureSliceProject());
    expect(slice.roomVisits).toBeGreaterThan(3);
    expect(slice.fights).toBeGreaterThan(0);
    expect(slice.minutes).toBeGreaterThan(1);
    // Twice the enemy health: longer fights, longer game.
    const tougher = fixtureSliceProject();
    const harder = { ...tougher, characters: tougher.characters.map((c) => (c.kind === "enemy" ? { ...c, stats: { ...c.stats, health: c.stats.health * 2 } } : c)) };
    expect(estimatePlayTime(harder).fightSeconds).toBeGreaterThan(slice.fightSeconds);
    expect(PACING.firstPlayFactor).toBeGreaterThan(1);
  });

  it("the pacing stage flags a game off its target", () => {
    const short = pacingStage(fixtureSliceProject());
    expect(short.issues).toEqual([expect.objectContaining({ stage: "plan", code: "too-short" })]);
    const relaxed = fixtureSliceProject();
    const fits = pacingStage({ ...relaxed, architect: { ...relaxed.architect, target: { minutes: [1, 60] } } });
    expect(fits.issues).toEqual([]);
    expect(fits.summary).toContain("target 1–60");
  });
});
