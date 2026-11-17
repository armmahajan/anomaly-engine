import { describe, expect, it } from "vitest";
import run4 from "./fixtures/agentBuiltRun4.json" with { type: "json" };
import agentBuilt from "./fixtures/agentBuiltRun.json" with { type: "json" };
import {
  createDefaultProject,
  fixtureProject,
  fixtureReferenceProject,
  fixtureSliceProject,
  lintLegibility,
  lintProject,
  migrateProject,
  ProjectSpec,
  type ProjectSpec as Project,
} from "../src/index.ts";
import { build, handBuiltProject } from "./architectPopulationWorld.ts";

// The legibility lints: silent_grant and skippable_guardian.

const legibility = (p: Project) => lintLegibility(p).map((w) => [w.code, w.path]);
const mapRoom = (p: Project, id: string, f: (r: Project["world"]["rooms"][number]) => Project["world"]["rooms"][number]): Project => ({
  ...p,
  world: { ...p.world, rooms: p.world.rooms.map((r) => (r.id === id ? f(r) : r)) },
});

describe("the agent-built game a creator playtested (run 4)", () => {
  // Its Cinder Beetle Queen in hollow_3 grants double jump (the way to the canopy) with only a
  // flash, and hollow_3's doors stay open: the player can walk past her and never know.
  const project = ProjectSpec.parse(migrateProject(run4));
  const hollow3 = project.world.rooms.findIndex((r) => r.id === "hollow_3");

  it("both lints catch the queen, through lintProject", () => {
    const warnings = lintProject(project).filter((w) => w.code === "silent_grant" || w.code === "skippable_guardian");
    expect(warnings.map((w) => [w.code, w.path])).toEqual([
      ["silent_grant", `world.rooms.${hollow3}.spawns.0.handlers.0`],
      ["skippable_guardian", `world.rooms.${hollow3}.spawns.0`],
    ]);
    expect(warnings[0]!.message).toContain('spawn "queen" (cinder_queen) in room "hollow_3" grants double_jump on enemyKilled with no message');
    expect(warnings[1]!.message).toContain('Cinder Beetle Queen (spawn "queen" in room "hollow_3") gives Cinder Wings');
    expect(warnings[1]!.message).toContain("to hollow_gate");
  });

  it("a message and a sealed room clear them", () => {
    let fixed = mapRoom(project, "hollow_3", (r) => {
      const queen = r.spawns[0]!;
      const sealed = { type: "all" as const, of: [{ type: "flag" as const, flag: "queen_sealed", is: true }, { type: "flag" as const, flag: "queen_beaten", is: false }] };
      return {
        ...r,
        spawns: [{ ...queen, handlers: [{ ...queen.handlers[0]!, do: [...queen.handlers[0]!.do, { type: "showModal" as const, modal: "title" }] }] }],
        handlers: [{ on: { type: "roomEntered" as const }, when: [], do: [{ type: "setFlag" as const, flag: "queen_sealed", value: true }] }],
        props: r.doors.map((d, i) => ({ id: `seal_${i}`, x: d.side === "left" ? 0 : 29 * 32, y: d.offset * 32, width: 32, height: d.size * 32, color: "#6a4a8c", art: null, solid: sealed, visible: sealed, health: null, bounce: false, prompt: null, handlers: [] })),
      };
    });
    expect(legibility(fixed)).toEqual([]);
    // A seal on the way in only (the far door open) is still skippable.
    fixed = mapRoom(fixed, "hollow_3", (r) => ({ ...r, props: r.props.slice(0, 1) }));
    expect(legibility(fixed)).toEqual([["skippable_guardian", `world.rooms.${hollow3}.spawns.0`]]);
  });
});

describe("the agent-built game of the build test (agentBuiltRun.json)", () => {
  // The same mistake: its crab guardian grants dash (on the critical path) silently, in a hall
  // that can be walked through. Kept as recorded, as a second real case.
  const project = ProjectSpec.parse(migrateProject(agentBuilt));
  it("is caught too", () => {
    const hall = project.world.rooms.findIndex((r) => r.id === "dome_crab_hall");
    expect(legibility(project)).toEqual([
      ["silent_grant", `world.rooms.${hall}.spawns.0.handlers.0`],
      ["skippable_guardian", `world.rooms.${hall}.spawns.0`],
    ]);
  });
});

describe("no false positives", () => {
  it.each([
    ["default project", createDefaultProject()],
    ["fixture world", fixtureProject()],
    ["fixture slice", fixtureSliceProject()],
    ["reference game", fixtureReferenceProject()],
  ])("%s", (_, project) => {
    expect(legibility(project)).toEqual([]);
  });

  it("a guardian in a dead end (its grant is the only way on) isn't skippable, sealed or not", () => {
    const game = build(handBuiltProject());
    const open = mapRoom(game, "depths_2", (r) => ({ ...r, props: [], handlers: [] }));
    expect(legibility(open)).toEqual([]);
  });
});

describe("planted cases on the population stage's own game", () => {
  const game = build(handBuiltProject());
  const depths2 = game.world.rooms.findIndex((r) => r.id === "depths_2");
  const depths1 = game.world.rooms.findIndex((r) => r.id === "depths_1");

  it("a guardian that doesn't lock its room, with the way on open", () => {
    const planted = build(
      handBuiltProject({
        contents: {
          depths_1: [{ kind: "enemy", characterId: "warden", count: 1, lockRoom: false, grants: ["wings"], healthBar: true }],
          depths_2: [{ kind: "enemy", characterId: "charger", count: 1, lockRoom: false, grants: [], healthBar: false }],
        },
      }),
    );
    const warnings = lintLegibility(planted);
    expect(warnings.map((w) => [w.code, w.path])).toEqual([["skippable_guardian", `world.rooms.${depths1}.spawns.0`]]);
    expect(warnings[0]!.message).toContain("(to depths_2)");
    // Locking it fixes it.
    const locked = build(
      handBuiltProject({
        contents: {
          depths_1: [{ kind: "enemy", characterId: "warden", count: 1, lockRoom: true, grants: ["wings"], healthBar: true }],
          depths_2: [{ kind: "enemy", characterId: "charger", count: 1, lockRoom: false, grants: [], healthBar: false }],
        },
      }),
    );
    expect(legibility(locked)).toEqual([]);
  });

  it("a grant without its message", () => {
    const planted = mapRoom(game, "depths_2", (r) => ({
      ...r,
      spawns: r.spawns.map((s) => ({ ...s, handlers: s.handlers.map((h) => ({ ...h, do: h.do.filter((e) => e.type !== "showModal") })) })),
    }));
    expect(legibility(planted)).toEqual([["silent_grant", `world.rooms.${depths2}.spawns.0.handlers.0`]]);
    // A twin handler (same event, same conditions) that shows the message counts.
    const twin = mapRoom(planted, "depths_2", (r) => ({
      ...r,
      spawns: r.spawns.map((s) => ({ ...s, handlers: [...s.handlers, { on: { type: "enemyKilled" as const }, when: [], do: [{ type: "showModal" as const, modal: "got_wings" }] }] })),
    }));
    expect(legibility(twin)).toEqual([]);
  });

  it("a guardian granted through the room being cleared", () => {
    const planted = mapRoom(
      build(handBuiltProject({ contents: { depths_1: [{ kind: "enemy", characterId: "charger", count: 2, lockRoom: false, grants: [], healthBar: false }], depths_2: [] } })),
      "depths_1",
      (r) => ({ ...r, handlers: [...r.handlers, { on: { type: "roomCleared" as const }, when: [], do: [{ type: "grantAbility" as const, ability: "double_jump" as const }, { type: "showModal" as const, modal: "title" }] }] }),
    );
    expect(legibility(planted)).toEqual([
      ["skippable_guardian", `world.rooms.${depths1}.spawns.0`],
      ["skippable_guardian", `world.rooms.${depths1}.spawns.1`],
    ]);
  });
});
