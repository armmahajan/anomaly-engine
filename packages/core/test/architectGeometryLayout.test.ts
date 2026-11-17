import { describe, expect, it } from "vitest";
import { fixtureReferenceProject, layoutStage, OPPOSITE, ProjectSpec, seedPlan, type ArchitectPlan, type ProjectSpec as Project } from "../src/index.ts";

const rect = (plan: ArchitectPlan, id: string) => {
  const r = plan.rooms.find((x) => x.id === id)!;
  return { x: r.at!.x, y: r.at!.y, w: r.cols, h: r.rows };
};
const overlaps = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** The two rooms touch along the facing sides of the link. */
function adjacent(plan: ArchitectPlan, link: ArchitectPlan["links"][number]): boolean {
  const a = rect(plan, link.a.room);
  const b = rect(plan, link.b.room);
  switch (link.a.side) {
    case "right":
      return a.x + a.w === b.x && a.y < b.y + b.h && b.y < a.y + a.h;
    case "left":
      return b.x + b.w === a.x && a.y < b.y + b.h && b.y < a.y + a.h;
    case "bottom":
      return a.y + a.h === b.y && a.x < b.x + b.w && b.x < a.x + a.w;
    case "top":
      return b.y + b.h === a.y && a.x < b.x + b.w && b.x < a.x + a.w;
    default:
      return false;
  }
}

function checkLayout(plan: ArchitectPlan) {
  for (const r of plan.rooms) expect(r.at, r.id).toBeDefined();
  for (let i = 0; i < plan.rooms.length; i++) {
    for (let j = i + 1; j < plan.rooms.length; j++) {
      expect(overlaps(rect(plan, plan.rooms[i]!.id), rect(plan, plan.rooms[j]!.id)), `${plan.rooms[i]!.id} / ${plan.rooms[j]!.id}`).toBe(false);
    }
  }
  for (const l of plan.links) {
    expect(l.a.side, l.id).toBeDefined();
    expect(l.b.side, l.id).toBe(OPPOSITE[l.a.side!]);
    if (l.oneWay) expect([l.a.side, l.b.side], l.id).toEqual(["bottom", "top"]);
  }
}

function withPlan(project: Project, plan: ArchitectPlan): Project {
  return ProjectSpec.parse({ ...project, architect: plan });
}

describe("layout stage", () => {
  const base = fixtureReferenceProject();

  it("places the reference game's rooms next to each other, sides facing, one-way links as drops", () => {
    const seeded = withPlan(base, seedPlan(base));
    const out = layoutStage(seeded);
    expect(out.issues).toEqual([]);
    const plan = out.project.architect;
    checkLayout(plan);
    // A tree of links (no cycles): every link joins rooms that touch.
    for (const l of plan.links) expect(adjacent(plan, l), l.id).toBe(true);
    expect(out.project.world).toEqual(seeded.world);
  });

  it("keeps the creator's sides and pinned rooms, and is deterministic", () => {
    const plan = seedPlan(base);
    const link = plan.links[0]!;
    link.a.side = "top";
    const pinned = plan.rooms[3]!;
    pinned.pinned = true;
    pinned.at = { x: 500, y: 500 };
    const project = withPlan(base, plan);
    const out = layoutStage(project);
    const next = out.project.architect;
    checkLayout(next);
    const kept = next.links.find((l) => l.id === link.id)!;
    expect([kept.a.side, kept.b.side]).toEqual(["top", "bottom"]);
    expect(next.rooms.find((r) => r.id === pinned.id)).toEqual(project.architect.rooms.find((r) => r.id === pinned.id));
    expect(layoutStage(project).project).toEqual(out.project);
  });

  it("lays out bigger random plans without overlaps, cycles included", () => {
    const ratios: number[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      let s = seed * 7919;
      const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
      const n = 6 + Math.floor(rnd() * 20);
      const rooms = Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `R${i}`, regionId: "undercroft", cols: 16 + Math.floor(rnd() * 60), rows: 10 + Math.floor(rnd() * 40) }));
      const links = rooms.slice(1).map((r, i) => ({ id: `l${i}`, a: { room: rooms[Math.floor(rnd() * (i + 1))]!.id }, b: { room: r.id }, oneWay: rnd() < 0.15 }));
      for (let k = 0; k < 3; k++) links.push({ id: `c${k}`, a: { room: rooms[Math.floor(rnd() * n)]!.id }, b: { room: rooms[Math.floor(rnd() * n)]!.id }, oneWay: false });
      const plan = { rooms, links: links.filter((l) => l.a.room !== l.b.room) };
      const project = ProjectSpec.parse({ ...base, architect: plan });
      const out = layoutStage(project);
      checkLayout(out.project.architect);
      const tree = out.project.architect.links.filter((l) => l.id.startsWith("l"));
      const touching = tree.filter((l) => adjacent(out.project.architect, l)).length;
      ratios.push(touching / tree.length);
    }
    console.log("touching", ratios.map((r) => r.toFixed(2)).join(" "));
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(0.4);
    expect(ratios.reduce((a, b) => a + b) / ratios.length).toBeGreaterThan(0.7);
  });
});
