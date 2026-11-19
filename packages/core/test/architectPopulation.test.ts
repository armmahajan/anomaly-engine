import { describe, expect, it } from "vitest";
import {
  applyOperation,
  borderedGrid,
  checkGame,
  fillTiles,
  fixtureReferenceProject,
  gateChecks,
  linkDoorId,
  lintProject,
  messageModalId,
  populationStage,
  ProjectSpec,
  roomBuildStamp,
  roomLinks,
  roomPlanChanged,
  screensStage,
  seedPlan,
  validateProject,
  type ProjectSpec as Project,
} from "../src/index.ts";
import { build, FLOOR, handBuiltProject } from "./architectPopulationWorld.ts";

// Population and screens on a small hand-built world (architectPopulationWorld.ts); the checker proves the result.

const roomOf = (p: Project, id: string) => p.world.rooms.find((r) => r.id === id)!;

describe("population and screens on a hand-built world", () => {
  const game = build(handBuiltProject());

  it("make a game the checker proves beatable with no dead states (resumed saves included)", () => {
    const result = checkGame(game);
    expect(result.hasEnding).toBe(true);
    expect(result.beatable).toBe(true);
    expect(result.deadStates).toEqual([]);
    expect(result.stats.truncated).toBe(false);
    // The route goes through the fight.
    expect(result.route!.some((s) => s.action.includes("defeat The Warden"))).toBe(true);
    // Gates hold: the peak needs wings, and the key gate keeps the depths shut without the key.
    expect(gateChecks(game, result).map((g) => [g.connection, g.holdsWithout, g.reachableWith])).toEqual([["depths_to_peak", true, true]]);
  });

  it("is lint-free, and every grant shows its message", () => {
    expect(lintProject(game)).toEqual([]);
    const handlers = game.world.rooms.flatMap((r) => [...r.handlers, ...r.props.flatMap((p) => p.handlers), ...r.spawns.flatMap((s) => s.handlers)]);
    const giving = handlers.filter((h) => h.do.some((e) => e.type === "grantAbility" || e.type === "giveItem"));
    expect(giving.length).toBe(2);
    for (const h of giving) expect(h.do.some((e) => e.type === "showModal")).toBe(true);
  });

  it("the start, the save points, the pickup, the ending and the screens", () => {
    expect(game.world.start).toMatchObject({ room: "cave_1", y: FLOOR * 32 });
    expect(game.world.playtest).toEqual({ ...game.world.start, abilities: [] });
    expect(roomOf(game, "cave_1").props.map((p) => [p.id, p.prompt])).toEqual([["save", "Rest"]]);
    const pickup = roomOf(game, "cave_2").props.find((p) => p.id === "pickup_rusty_key")!;
    expect(pickup.handlers[0]!.do).toEqual([
      { type: "setFlag", flag: "got_rusty_key", value: true },
      { type: "giveItem", item: "rusty_key", count: 1 },
      { type: "showModal", modal: "got_rusty_key" },
    ]);
    expect(game.world.items.map((i) => i.id)).toEqual(["rusty_key"]);
    const ending = roomOf(game, "peak_1").props.find((p) => p.id === "ending")!;
    expect(ending.handlers[0]!.do).toEqual([{ type: "endGame", modal: "ending" }]);

    const modal = (id: string) => game.world.modals.find((m) => m.id === id)!;
    expect(modal("title")).toMatchObject({ title: "Hollow Deep", body: "A lantern-bearer descends into the The Cave and climbs to the The Peak.", buttons: [{ label: "Begin" }] });
    expect(game.world.handlers).toContainEqual({ on: { type: "gameStarted" }, when: [], do: [{ type: "showModal", modal: "title" }] });
    expect(modal("ending")).toMatchObject({ title: "The End" });
    expect(modal("ending").body).toContain("Wind and open sky");
    expect(modal(messageModalId("wings"))).toMatchObject({ title: "You got Wings" });
    expect(modal(messageModalId("wings")).body).toContain("Moth wings, torn from the Warden.");
    expect(modal(messageModalId("wings")).body).toContain("Jump again in mid-air.");
    expect(modal(messageModalId("wings")).body).toContain("It opens the way to The Peak.");
    expect(modal(messageModalId("rusty_key")).body).toContain("It opens the way to The Depths.");
    expect(game.world.map.enabled).toBe(true);
  });

  it("enemies stand on reachable floor, away from the doors", () => {
    for (const r of game.world.rooms) {
      for (const s of r.spawns) {
        expect(s.y).toBe(r.id === "peak_1" ? 7 * 32 : FLOOR * 32);
        for (const d of r.doors.filter((d) => d.side === "left")) expect(s.x).toBeGreaterThan(5 * 32);
      }
    }
    expect(roomOf(game, "cave_2").spawns.map((s) => s.id)).toEqual(["crawler_1", "crawler_2"]);
    const [a, b] = roomOf(game, "cave_2").spawns;
    expect(Math.abs(a!.x - b!.x)).toBeGreaterThan(4 * 32);
  });

  it("the guardian seals its room until it falls; then it grants wings with a message, saves, and stays beaten", () => {
    const arena = roomOf(game, "depths_2");
    const warden = arena.spawns[0]!;
    expect(warden).toMatchObject({ characterId: "warden", when: { type: "flag", flag: "depths_2_warden_beaten", is: false }, healthBar: { title: "The Warden" } });
    expect(warden.handlers).toEqual([
      {
        on: { type: "enemyKilled" },
        when: [],
        do: [
          { type: "setFlag", flag: "depths_2_warden_beaten", value: true },
          { type: "grantAbility", ability: "double_jump" },
          { type: "shake", strength: 10, seconds: 0.5 },
          { type: "slowMotion", scale: 0.3, seconds: 0.8 },
          { type: "showModal", modal: "got_wings" },
          { type: "saveRun" },
        ],
      },
    ]);
    expect(arena.handlers).toEqual([{ on: { type: "roomEntered" }, when: [{ type: "flag", flag: "depths_2_warden_beaten", is: false }], do: [{ type: "setFlag", flag: "depths_2_sealed", value: true }] }]);
    const closed = { type: "all", of: [{ type: "flag", flag: "depths_2_sealed", is: true }, { type: "flag", flag: "depths_2_warden_beaten", is: false }] };
    expect(arena.props.map((p) => [p.id, p.solid, p.visible])).toEqual(arena.doors.map((d) => [`seal_${d.id}`, closed, closed]));
    // The far door is under the seal.
    const far = arena.props.find((p) => p.id === `seal_${linkDoorId("depths_to_peak", "a")}`)!;
    expect([far.x, far.y, far.width, far.height]).toEqual([29 * 32, 3 * 32, 32, 96]);
  });

  it("a key gate at the link's door in its `a` room, solid while the key is missing", () => {
    const gate = roomOf(game, "cave_2").props.find((p) => p.id === "gate_cave_to_depths")!;
    const lacking = { type: "not", of: { type: "item", item: "rusty_key", atLeast: 1 } };
    expect(gate).toMatchObject({ x: 29 * 32, y: 10 * 32, width: 32, height: 96, solid: lacking, visible: lacking });
    // Without the key the depths are out of reach.
    const keyless = { ...game, world: { ...game.world, rooms: game.world.rooms.map((r) => ({ ...r, props: r.props.filter((p) => p.id !== "pickup_rusty_key") })) } };
    const result = checkGame(keyless);
    expect(result.beatable).toBe(false);
    expect(result.reachableRooms).toEqual(["cave_1", "cave_2"]);
  });
});

describe("no dead states however the fight goes", () => {
  it.each([
    ["onDeath room", { onDeath: "room" as const }],
    ["onDeath checkpoint", { onDeath: "checkpoint" as const }],
    ["onDeath start", { onDeath: "start" as const }],
    ["no saving", { save: "never" as const }],
  ])("%s", (_, rules) => {
    const result = checkGame(build(handBuiltProject({ rules })));
    expect([result.beatable, result.deadStates]).toEqual([true, []]);
  });

  it("several guardians: the room opens and grants when the last falls, whatever the order and however many deaths", () => {
    const game = build(
      handBuiltProject({ contents: { depths_2: [{ kind: "enemy", characterId: "warden", count: 3, lockRoom: true, grants: ["wings"], healthBar: true }] } }),
    );
    const arena = roomOf(game, "depths_2");
    expect(arena.spawns.map((s) => s.id)).toEqual(["warden_1", "warden_2", "warden_3"]);
    const last = arena.spawns[0]!.handlers[1]!;
    expect(last.when).toEqual([{ type: "all", of: [{ type: "flag", flag: "depths_2_warden_warden_2_down", is: true }, { type: "flag", flag: "depths_2_warden_warden_3_down", is: true }] }]);
    expect(last.do).toContainEqual({ type: "grantAbility", ability: "double_jump" });
    // Who fell this visit starts over on every entry.
    expect(arena.handlers[0]).toEqual({
      on: { type: "roomEntered" },
      when: [],
      do: ["warden_1", "warden_2", "warden_3"].map((s) => ({ type: "setFlag", flag: `depths_2_warden_${s}_down`, value: false })),
    });
    for (const onDeath of ["room", "checkpoint"] as const) {
      const result = checkGame(build(handBuiltProject({ rules: { onDeath }, contents: { depths_2: [{ kind: "enemy", characterId: "warden", count: 3, lockRoom: true, grants: ["wings"], healthBar: true }] } })));
      expect([result.beatable, result.deadStates]).toEqual([true, []]);
    }
    expect(lintProject(game)).toEqual([]);
  });

  it("a guardian that gives the key, in a room that locks", () => {
    const game = build(
      handBuiltProject({
        contents: {
          cave_2: [
            { kind: "enemy", characterId: "crawler", count: 2, lockRoom: true, grants: ["rusty_key"], healthBar: true },
            { kind: "enemy", characterId: "charger", count: 1, lockRoom: false, grants: [], healthBar: false },
          ],
        },
      }),
    );
    const result = checkGame(game);
    expect([result.beatable, result.deadStates]).toEqual([true, []]);
    expect(lintProject(game)).toEqual([]);
    expect(roomOf(game, "cave_2").props.map((p) => p.id)).toEqual(["gate_cave_to_depths", `seal_${linkDoorId("c1_c2", "b")}`, `seal_${linkDoorId("cave_to_depths", "a")}`]);
  });
});

describe("the stages' contract", () => {
  it("pinned rooms are untouched", () => {
    const base = handBuiltProject({ pinned: ["depths_1"] });
    const mine = {
      ...roomOf(base, "depths_1"),
      spawns: [{ id: "mine", characterId: "charger", x: 400, y: FLOOR * 32, when: null, healthBar: null, handlers: [] }],
      props: [{ id: "lamp", x: 300, y: 300, width: 20, height: 20, color: "#ffffff", art: null, solid: false, visible: true, health: null, bounce: false, prompt: null, handlers: [] }],
    };
    const project = ProjectSpec.parse({ ...base, world: { ...base.world, rooms: base.world.rooms.map((r) => (r.id === "depths_1" ? mine : r)) } });
    const before = structuredClone(roomOf(project, "depths_1"));
    const after = screensStage(populationStage(project).project).project;
    expect(roomOf(after, "depths_1")).toEqual(before);
    expect(roomOf(after, "depths_2").spawns.length).toBe(1);
  });

  it("only the rooms asked for", () => {
    const project = handBuiltProject();
    const out = populationStage(project, { rooms: ["cave_2"] }).project;
    for (const r of out.world.rooms) {
      if (r.id === "cave_2") expect(r.spawns.length).toBe(2);
      else expect(r).toEqual(roomOf(project, r.id));
    }
    expect(out.world.start).toBeNull();
  });

  it("is deterministic and idempotent", () => {
    const project = handBuiltProject();
    const once = build(project);
    expect(build(project)).toEqual(once);
    expect(build(once)).toEqual(once);
  });

  it("an ending after the guardian: no marker; the game ends the moment the room's guardian falls, and the checker proves it", () => {
    const fight = { kind: "enemy" as const, characterId: "crawler", count: 1, lockRoom: true, grants: [], healthBar: true };
    const game = build(handBuiltProject({ contents: { peak_1: [fight, { kind: "ending", after: "guardian" }] } }));
    const peak = roomOf(game, "peak_1");
    expect(peak.props.some((p) => p.handlers.some((h) => h.do.some((e) => e.type === "endGame")))).toBe(false);
    const ends = peak.spawns.flatMap((sp) => sp.handlers).filter((h) => h.do.some((e) => e.type === "endGame"));
    expect(ends).toHaveLength(1);
    expect(ends[0]!.on.type).toBe("enemyKilled");
    expect(game.world.modals.some((m) => m.id === "ending")).toBe(true);
    const result = checkGame(game);
    expect(result).toMatchObject({ hasEnding: true, beatable: true, deadStates: [] });
    expect(result.route!.at(-1)!.action).toContain("defeat");
    // With no guardian to wait on, population says so.
    const lonely = populationStage(handBuiltProject({ contents: { peak_1: [{ kind: "ending", after: "guardian" }] } }));
    expect(lonely.issues).toContainEqual(expect.objectContaining({ code: "ending-no-guardian", roomId: "peak_1" }));
  });

  it("stamps each room it fills with the plan it was built from; a change that shapes the room shows, a rename doesn't", () => {
    const game = build(handBuiltProject());
    const room = game.architect.rooms.find((r) => r.id === "cave_2")!;
    expect(room.built).toBe(roomBuildStamp(game.architect, room));
    expect(roomPlanChanged(game.architect, room)).toBe(false);
    const edit = (changes: Record<string, unknown>) => {
      const r = applyOperation(game, "updateRoomPlan", { roomId: "cave_2", changes });
      if (!r.ok) throw new Error(r.error.message);
      return r.project.architect;
    };
    const contents = edit({ contents: [...room.contents, { kind: "save" }] });
    expect(roomPlanChanged(contents, contents.rooms.find((r) => r.id === "cave_2")!)).toBe(true);
    const renamed = edit({ name: "The Wet Cave", notes: "drippy" });
    expect(roomPlanChanged(renamed, renamed.rooms.find((r) => r.id === "cave_2")!)).toBe(false);
    // Built again, it matches again.
    const rebuilt = populationStage({ ...game, architect: contents }).project.architect;
    expect(roomPlanChanged(rebuilt, rebuilt.rooms.find((r) => r.id === "cave_2")!)).toBe(false);
  });

  it("a prop rebuilt in its old place keeps its drawn art (running population again doesn't undo the art)", () => {
    const once = build(handBuiltProject());
    const room = once.world.rooms.find((r) => r.props.length > 0)!;
    const target = room.props[0]!;
    // (No real kit in this fixture: the stage only carries the reference over.)
    const drawn: Project = {
      ...once,
      world: { ...once.world, rooms: once.world.rooms.map((r) => (r.id === room.id ? { ...r, props: r.props.map((p) => (p.id === target.id ? { ...p, art: { biome: "kit", piece: "lamp" } } : p)) } : r)) },
    };
    const again = populationStage(drawn).project;
    expect(roomOf(again, room.id).props.find((p) => p.id === target.id)?.art).toEqual({ biome: "kit", piece: "lamp" });
    expect(roomOf(again, room.id).props.filter((p) => p.id !== target.id).every((p) => p.art === null)).toBe(true);
  });

  it("a plan naming an enemy that doesn't exist yet gets a placeholder for the cast stage", () => {
    const project = handBuiltProject({ contents: { depths_1: [{ kind: "enemy", characterId: "ember_moth", count: 1, lockRoom: false, grants: [], healthBar: false }] } });
    const out = populationStage(project);
    expect(out.issues).toEqual([expect.objectContaining({ stage: "cast", code: "placeholder-character", roomId: "depths_1" })]);
    expect(out.project.characters.find((c) => c.id === "ember_moth")).toMatchObject({ kind: "enemy", name: "Ember Moth" });
    expect(validateProject(out.project).ok).toBe(true);
  });

  it("reports what it can't build", () => {
    const project = handBuiltProject();
    const noDoor = { ...project, world: { ...project.world, rooms: project.world.rooms.filter((r) => r.id !== "peak_1") } };
    const out = populationStage(noDoor);
    expect(out.issues).toEqual([expect.objectContaining({ stage: "geometry", code: "missing-room", roomId: "peak_1" })]);
  });
});

describe("the seeded plan of the reference game", () => {
  // seedPlan from the progression alone, on plain rooms in a chain (each link a right door to a left door),
  // standing in for the geometry stage: the guardian's room locks, the hatch key gates its link.
  const reference = fixtureReferenceProject();
  const plan = seedPlan(reference);
  const rooms = plan.rooms.map((r, i) => {
    const doors = roomLinks(plan, r.id).map(({ link, here }) => {
      const there = here === "a" ? "b" : "a";
      return { id: linkDoorId(link.id, here), side: here === "a" ? ("right" as const) : ("left" as const), offset: 10, size: 3, to: { room: link[there].room, door: linkDoorId(link.id, there) } };
    });
    let grid = borderedGrid(30, 14);
    for (const d of doors) grid = fillTiles(grid, { col: d.side === "left" ? 0 : 29, row: 10, cols: 1, rows: 3 }, "empty");
    return { id: r.id, name: r.name, regionId: r.regionId, grid, at: { x: 30 * i, y: 0 }, doors, spawns: [], props: [], handlers: [] };
  });
  // Its title and ending stay; the screens of its old rooms go with them.
  const modals = reference.world.modals.filter((m) => m.id === "title" || m.id === "ending");
  const project = ProjectSpec.parse({ ...reference, architect: plan, world: { ...reference.world, rooms, modals, start: null, playtest: null } });
  const game = build(project);

  it("is beatable with no dead states, through the guardian, and lint-free", () => {
    const result = checkGame(game);
    expect([result.beatable, result.deadStates]).toEqual([true, []]);
    expect(result.route!.map((s) => s.action).filter((a) => a.startsWith("defeat") || a.startsWith("touch"))).toEqual([
      "touch Hatch key",
      "defeat The Iron Guardian",
      "touch The end: The Summit: the game ends",
    ]);
    expect(lintProject(game)).toEqual([]);
  });

  it("keeps the reference's own screens and adds the messages", () => {
    expect(game.world.modals.map((m) => m.id)).toEqual(["title", "ending", "got_hatch_key", "got_double_jump"]);
    expect(game.world.handlers.filter((h) => h.on.type === "gameStarted")).toHaveLength(1);
  });
});
