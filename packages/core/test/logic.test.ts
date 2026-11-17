import { describe, expect, it } from "vitest";
import {
  borderedGrid,
  checkGame,
  createDefaultProject,
  fillTiles,
  fixtureReferenceProject,
  fixtureSliceProject,
  movementModel,
  movementParams,
  ProjectSpec,
  TILE,
  type CheckResult,
  type PlayerCharacter,
} from "../src/index.ts";

// The logic-aware checker (world/logic/check.ts): beatable, no dead states,
// a readable counterexample when not. Mutations of the slice each break it
// one way; each must be caught, its last steps and `why` naming the problem.

const flag = (name: string, is = true) => ({ type: "flag", flag: name, is });
const steps = (r: CheckResult["deadStates"][number]) => r.path.map((s) => s.action);
const show = (r: CheckResult) => r.deadStates.map((d) => `${d.why}\n  ${steps(d).join("\n  ")}`).join("\n");

/** The slice with rooms changed by `edit` (room id -> changes) and world fields merged in. */
function mutate(edit: Record<string, (room: Record<string, any>) => Record<string, any>>, world: Record<string, unknown> = {}, extraRooms: unknown[] = []): ProjectSpec {
  const base = fixtureSliceProject();
  return ProjectSpec.parse({
    ...base,
    world: { ...base.world, ...world, rooms: [...base.world.rooms.map((r) => (edit[r.id] ? edit[r.id]!(r as any) : r)), ...extraRooms] },
  });
}

const prop = (id: string, name: string, x: number, y: number, width: number, height: number, rest: Record<string, unknown> = {}) => ({ id, name, x, y, width, height, ...rest });
/** A wall across the hall, three tiles in from its west door, solid while hall_shut. */
const barrier = prop("barrier", "Barrier", 3 * TILE, TILE, TILE, 11 * TILE, { solid: flag("hall_shut") });
/** A plate on the hall floor east of it that shuts it (only with the key, when `keyOnly`). */
const plate = (keyOnly: boolean) =>
  prop("plate", "Pressure plate", 8 * TILE, 12 * TILE - 8, 2 * TILE, 8, { handlers: [{ on: { type: "touch" }, when: keyOnly ? [{ type: "item", item: "key" }] : [], do: [{ type: "setFlag", flag: "hall_shut" }] }] });

describe("the fixture games", () => {
  it("the slice is beatable, with no dead states (Continue included), along a sensible route", () => {
    const r = checkGame(fixtureSliceProject());
    expect(show(r)).toBe("");
    expect(r).toMatchObject({ hasEnding: true, beatable: true, deadStates: [], stats: { truncated: false } });
    const route = r.route!.map((s) => `${s.room}: ${s.action}`);
    const order = ["entrance: touch Key", "hall: use Lock post", "sanctum: defeat The Iron Guardian", "summit: touch Altar: the game ends"].map((a) => route.indexOf(a));
    expect(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]!))).toBe(true);
    expect(r.route!.at(-1)!.memory.abilities).toEqual(["double_jump"]);
    expect(r.reachableRooms).toEqual(["bridge", "cistern", "entrance", "hall", "sanctum", "spikes", "summit"]);
  });

  it("the reference game is beatable with no dead states", () => {
    const r = checkGame(fixtureReferenceProject());
    expect(show(r)).toBe("");
    expect(r.beatable).toBe(true);
  });

  it("withoutAbilities: the summit needs double jump", () => {
    const project = fixtureReferenceProject();
    expect(checkGame(project).reachableRooms).toContain("summit");
    const without = checkGame(project, { withoutAbilities: ["double_jump"] });
    expect(without.reachableRooms).not.toContain("summit");
    expect(without.reachableRooms).toContain("sanctum");
    expect(without.beatable).toBe(false);
    expect(without.deadStates[0]!.why).toContain("double_jump");
  });

  it("checks the starter project from its playtest (no ending yet) and stops when told", () => {
    expect(checkGame(createDefaultProject())).toMatchObject({ hasEnding: false, beatable: false, reachableRooms: ["arena"] });
    const partial = checkGame(fixtureSliceProject(), { maxStates: 40 });
    expect(partial).toMatchObject({ beatable: false, deadStates: [], stats: { truncated: true } });
  });

  it("is deterministic and fast", () => {
    const strip = (r: CheckResult) => ({ ...r, stats: { ...r.stats, ms: 0 } });
    const a = checkGame(fixtureSliceProject());
    expect(strip(checkGame(fixtureSliceProject()))).toEqual(strip(a));
    expect(a.stats.ms).toBeLessThan(2000);
  });
});

describe("mutations of the slice are caught", () => {
  it("(a) a decoy lock that consumes the key", () => {
    const decoy = prop("decoy", "Rusty lock", 20 * TILE, 10 * TILE, TILE, 2 * TILE, {
      handlers: [{ on: { type: "interact" }, when: [{ type: "item", item: "key" }], do: [{ type: "takeItem", item: "key" }] }],
    });
    const r = checkGame(mutate({ hall: (room) => ({ ...room, props: [...room.props, decoy] }) }));
    expect(r.beatable).toBe(true);
    const dead = r.deadStates[0]!;
    expect(steps(dead).at(-1)).toBe("use Rusty lock");
    expect(dead.why).toMatch(/Lock post.*needs item key; no key is left/);
  });

  it("(b) a one-way drop into a room that needs an ability you don't have yet", () => {
    const project = fixtureSliceProject();
    const params = movementParams(project.characters[0] as PlayerCharacter, project.world.gravity);
    const h1 = movementModel(params, []).maxHeight;
    const h2 = movementModel(params, ["double_jump"]).maxHeight;
    // The pit's floor is deeper than one jump and shallower than two below its top door.
    const floorRow = Math.ceil((params.height / 2 + (h1 + h2) / 2) / TILE);
    let grid = fillTiles(borderedGrid(12, floorRow + 2), { col: 1, row: floorRow, cols: 10, rows: 1 }, "solid");
    grid = fillTiles(grid, { col: 4, row: 0, cols: 3, rows: 1 }, "empty");
    const pit = { id: "pit", name: "Pit", at: { x: 18, y: 14 }, grid, doors: [{ id: "up", side: "top", offset: 4, size: 3, to: { room: "entrance", door: "hole" } }] };
    const r = checkGame(
      mutate(
        {
          entrance: (room) => ({
            ...room,
            grid: fillTiles(room.grid, { col: 18, row: 12, cols: 3, rows: 2 }, "empty"),
            doors: [...room.doors, { id: "hole", side: "bottom", offset: 18, size: 3, to: { room: "pit", door: "up" } }],
          }),
        },
        {},
        [pit],
      ),
    );
    expect(r.beatable).toBe(true);
    const dead = r.deadStates.find((d) => d.path.at(-1)!.room === "pit")!;
    expect(steps(dead).at(-2)).toBe("drop through door hole into pit");
    expect(dead.why).toMatch(/stuck in pit: .*needs double_jump/);
  });

  it("(c) a barrier that closes behind you with nothing to reopen it", () => {
    const r = checkGame(mutate({ hall: (room) => ({ ...room, props: [...room.props, barrier, plate(false)] }) }));
    expect(r.beatable).toBe(true);
    const dead = r.deadStates.find((d) => !d.fromSave)!;
    expect(steps(dead).at(-1)).toMatch(/Pressure plate/);
    expect(dead.why).toMatch(/Barrier.*hall_shut/);
  });

  it("(d) a flag set under one name and checked under another", () => {
    const r = checkGame(
      mutate({
        hall: (room) => ({ ...room, props: room.props.map((p: any) => (p.id === "hatch" ? { ...p, solid: flag("hatch_opened", false), visible: flag("hatch_opened", false) } : p)) }),
      }),
    );
    expect(r.beatable).toBe(false);
    const dead = r.deadStates[0]!;
    expect(steps(dead).at(-1)).toBe("use Lock post");
    expect(dead.why).toMatch(/Hatch.*nothing in the game sets flag hatch_opened \(hatch_open is set/);
  });

  it("(e) a save point that saves a dead state: Continue is stuck", () => {
    const stone = prop("stone", "Save stone", 12 * TILE, 10 * TILE, TILE, 2 * TILE, { handlers: [{ on: { type: "interact" }, do: [{ type: "saveRun" }] }] });
    const r = checkGame(mutate({ hall: (room) => ({ ...room, props: [...room.props, barrier, plate(true), stone] }) }));
    expect(r.beatable).toBe(true);
    const dead = r.deadStates[0]!;
    expect(dead.fromSave).toBe(true);
    expect(steps(dead).join(" / ")).toMatch(/use Save stone \/ quit, then Continue \(saved in hall\) \/ press "Begin" \(Descent\) \/ land at [^/]*$/);
    expect(dead.why).toBe("after Continue: stuck in entrance, hall: Barrier blocks the way (solid while flag hall_shut)");
    // Also caught: dying before any checkpoint sends you back to the start, behind the barrier.
    expect(r.deadStates.some((d) => !d.fromSave && steps(d).includes("die"))).toBe(true);
  });

  it("(f) no endGame anywhere", () => {
    const r = checkGame(
      mutate({ summit: (room) => ({ ...room, props: room.props.map((p: any) => ({ ...p, handlers: [{ on: { type: "touch" }, do: [{ type: "setFlag", flag: "at_altar" }] }] })) }) }),
    );
    expect(r).toMatchObject({ hasEnding: false, beatable: false, route: null });
    expect(r.deadStates[0]!.why).toMatch(/no ending/);
    expect(r.reachableRooms).toContain("summit");
  });
});

describe("a synthetic 30-room game", () => {
  /** Rooms r0..r29 in a row; a key in r5 opens a gate in r12, a switch in r20 lowers a wall in r22, the end in r29. */
  function corridor(): ProjectSpec {
    const base = fixtureSliceProject();
    const rooms = Array.from({ length: 30 }, (_, i) => {
      let grid = borderedGrid(20, 12);
      const doors = [];
      if (i > 0) (grid = fillTiles(grid, { col: 0, row: 8, cols: 1, rows: 3 }, "empty")), doors.push({ id: "w", side: "left", offset: 8, size: 3, to: { room: `r${i - 1}`, door: "e" } });
      if (i < 29) (grid = fillTiles(grid, { col: 19, row: 8, cols: 1, rows: 3 }, "empty")), doors.push({ id: "e", side: "right", offset: 8, size: 3, to: { room: `r${i + 1}`, door: "w" } });
      if (i % 3 === 1) grid = fillTiles(grid, { col: 6, row: 8, cols: 4, rows: 1 }, "ledge");
      const props: unknown[] = [];
      if (i === 5) props.push(prop("key", "Key", 7 * TILE, 7 * TILE - 24, 24, 24, { visible: flag("got_key", false), handlers: [{ on: { type: "touch" }, do: [{ type: "giveItem", item: "key" }, { type: "setFlag", flag: "got_key" }] }] }));
      if (i === 12) {
        props.push(prop("gate", "Gate", 12 * TILE, 8 * TILE, TILE, 3 * TILE, { solid: flag("open", false), visible: flag("open", false) }));
        props.push(prop("lock", "Lock", 9 * TILE, 9 * TILE, TILE, 2 * TILE, { handlers: [{ on: { type: "interact" }, when: [{ type: "item", item: "key" }], do: [{ type: "takeItem", item: "key" }, { type: "setFlag", flag: "open" }] }] }));
      }
      if (i === 20) props.push(prop("switch", "Switch", 10 * TILE, 10 * TILE, TILE, TILE, { handlers: [{ on: { type: "interact" }, do: [{ type: "setFlag", flag: "lit" }, { type: "showModal", modal: "lit" }] }] }));
      if (i === 22) props.push(prop("wall", "Wall", 10 * TILE, 8 * TILE, TILE, 3 * TILE, { solid: flag("lit", false) }));
      if (i === 29) props.push(prop("end", "End", 15 * TILE, 9 * TILE, TILE, 2 * TILE, { handlers: [{ on: { type: "touch" }, do: [{ type: "endGame" }] }] }));
      if (i % 7 === 3) props.push(prop(`coin${i}`, "Coin", 4 * TILE, 10 * TILE, 16, 16, { visible: flag(`coin${i}`, false), handlers: [{ on: { type: "touch" }, do: [{ type: "giveItem", item: "coin" }, { type: "setFlag", flag: `coin${i}` }] }] }));
      return { id: `r${i}`, name: `Room ${i}`, at: { x: i * 20, y: 0 }, grid, doors, props };
    });
    return ProjectSpec.parse({
      ...base,
      world: {
        ...base.world,
        rooms,
        start: { room: "r0", x: 3 * TILE, y: 11 * TILE },
        playtest: null,
        items: [{ id: "key", name: "Key" }, { id: "coin", name: "Coin" }],
        modals: [{ id: "lit", title: "Something moved" }],
        handlers: [{ on: { type: "roomEntered", room: "r25" }, when: [{ type: "item", item: "coin", atLeast: 3 }], do: [{ type: "setFlag", flag: "rich" }] }],
        rules: { onDeath: "room", save: "room", hazardDamage: 1 },
      },
    });
  }

  it("is beatable with no dead states, well within 30 s", () => {
    const r = checkGame(corridor());
    expect(show(r)).toBe("");
    expect(r.beatable).toBe(true);
    expect(r.reachableRooms).toHaveLength(30);
    expect(r.stats.ms).toBeLessThan(30_000);
  }, 60_000);
});
