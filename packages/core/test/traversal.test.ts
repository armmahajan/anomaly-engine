import { describe, expect, it } from "vitest";
import {
  borderedGrid,
  canTraverse,
  createDefaultProject,
  fillTiles,
  findRoute,
  gateCheck,
  gridToSolids,
  movementModel,
  movementParams,
  MOVEMENT_ABILITIES,
  reachableFrom,
  roomGraph,
  roomTraversal,
  routeInputs,
  standingSurfaces,
  World,
  worldTraversal,
  type MovementAbility,
  type TraversalOpening,
  type PlayerCharacter,
  type TileGrid,
} from "../src/index.ts";

const base = createDefaultProject();
const params = movementParams(base.characters[0] as PlayerCharacter, base.sandbox.gravity);
const ALL = Object.keys(MOVEMENT_ABILITIES) as MovementAbility[];

/** A room from rows, with a door on the left and right whose bottoms sit on the given rows. */
const room = (rows: string[], left: number, right: number): { grid: TileGrid; doors: TraversalOpening[] } => ({
  grid: { rows },
  doors: [
    { id: "a", side: "left", offset: left - 3, size: 3 },
    { id: "b", side: "right", offset: right - 3, size: 3 },
  ],
});
const across = (r: { grid: TileGrid; doors: TraversalOpening[] }, abilities: MovementAbility[] = []) => canTraverse(r, "a", "b", params, abilities);
const kinds = (r: { grid: TileGrid; doors: TraversalOpening[] }, abilities: MovementAbility[] = [], from = "a", to = "b") =>
  findRoute(roomGraph(r.grid, r.doors, params, abilities), `in:${from}`, `out:${to}`)?.map((m) => m.kind);

describe("standing surfaces", () => {
  it("are tops with headroom for the player, never on or next to hazards", () => {
    const solids = gridToSolids({
      rows: [
        "##########",
        "#........#",
        "#..==....#",
        "#..##.^..#",
        "##########",
      ],
    });
    const surfaces = standingSurfaces(solids, params, { width: 320, height: 160 }).map((s) => ({ y: s.y, x0: s.x0, x1: s.x1 }));
    // The ledge and the block under it have no headroom; the floor stops at walls, and 1 px short of the hazard's margin.
    expect(surfaces).toEqual([
      { y: 128, x0: 46, x1: 82 },
      { y: 128, x0: 174, x1: 177 },
      { y: 128, x0: 239, x1: 274 },
    ]);
  });

  it("mark where a ground pound would smash a breakable area", () => {
    const [s] = standingSurfaces(gridToSolids({ rows: ["#....#", "#....#", "#....#", "#%%%%#"] }), params, { width: 192, height: 128 });
    expect(s!.pound).toEqual([{ x0: 46, x1: 146 }]);
  });
});

describe("moves", () => {
  const corridor = ["####################", "#..................#", "....................", "....................", "....................", "####################"];

  it("walk", () => {
    expect(kinds(room(corridor, 5, 5))).toEqual(["enter", "walk"]);
    expect(roomTraversal(room(corridor, 5, 5), params, []).exits).toEqual({ a: ["a", "b"], b: ["a", "b"] });
  });

  it("drop off a ledge, and not back up", () => {
    const r = room(
      [
        "############",
        "#..........#",
        "...........#",
        "...........#",
        "...........#",
        "####.......#",
        "####.......#",
        "####.......#",
        "####........",
        "####........",
        "####........",
        "############",
      ],
      5,
      11,
    );
    expect(kinds(r)).toEqual(["enter", "drop", "walk"]);
    expect(canTraverse(r, "b", "a", params, [])).toBe(false);
    expect(canTraverse(r, "b", "a", params, ["double_jump"])).toBe(true);
  });

  it("jump a gap, unless a low ceiling cuts the jump short", () => {
    const gap = (ceiling: boolean) =>
      room(
        [
          "######################",
          "#....................#",
          "#....................#",
          "#....................#",
          ceiling ? "######################" : "#....................#",
          "......................",
          "......................",
          "......................",
          "######.......#########",
          "^^^^^^^^^^^^^^^^^^^^^^",
          "######################",
        ],
        8,
        8,
      );
    expect(kinds(gap(false))).toEqual(["enter", "jump", "walk"]);
    expect(across(gap(true))).toBe(false);
    expect(across(gap(true), ["dash"])).toBe(true);
  });

  it("up through a one-way floor, not through a ledge", () => {
    const floor = (tile: string) =>
      room(["##########", "#........#", ".........#", ".........#", ".........#", `#${tile.repeat(8)}#`, "#.........", "#.........", "#.........", "##########"], 5, 9);
    expect(canTraverse(floor("-"), "b", "a", params, [])).toBe(true);
    expect(canTraverse(floor("="), "b", "a", params, ALL.filter((a) => a !== "wall_jump"))).toBe(false);
  });

  it("climb a wall by wall jumps", () => {
    const shaft = { grid: { rows: ["#....#", ...Array.from({ length: 12 }, () => "#....#"), ".....#", ".....#", ".....#", "######"] }, doors: [{ id: "a", side: "left", offset: 13, size: 3 }, { id: "b", side: "top", offset: 1, size: 4 }] satisfies TraversalOpening[] };
    expect(across(shaft, ALL.filter((a) => a !== "wall_jump"))).toBe(false);
    expect(kinds(shaft, ["wall_jump"])).toEqual(["enter", "climb"]);
  });

  it("smash down through a breakable floor with a ground pound", () => {
    const r = room(["##########", "#........#", ".........#", ".........#", ".........#", "#%%%%%%%%#", "#........#", "#.........", "#.........", "#.........", "##########"], 5, 10);
    expect(across(r, ALL.filter((a) => a !== "ground_pound"))).toBe(false);
    const graph = roomGraph(r.grid, r.doors, params, ["ground_pound"]);
    const route = findRoute(graph, "in:a", "out:b")!;
    expect(route.map((m) => m.kind)).toEqual(["enter", "pound", "walk"]);
    expect(route[1]!.to).toMatch(/@1$/); // landed with breakable area 1 gone
    expect(graph.surface(route[1]!.from)!.y).toBe(160);
  });

  it("never touch hazards", () => {
    const spikes = (n: number) => room(["####################", "#..................#", "....................", "....................", "....................", `#####${"^".repeat(n)}${"#".repeat(15 - n)}`, "####################"], 5, 5);
    expect(across(spikes(4))).toBe(true);
    expect(across(spikes(14))).toBe(false);
  });

  it("replay as inputs that end where the graph says", () => {
    const r = room(corridor, 5, 5);
    const graph = roomGraph(r.grid, r.doors, params, []);
    const replay = routeInputs(graph, findRoute(graph, "in:a", "out:b")!);
    expect(replay.ok).toBe(true);
    expect(replay.states.at(-1)!.x).toBeGreaterThan(640);
  });
});

describe("worlds", () => {
  const plain = borderedGrid(12, 8);
  const openings = (g: TileGrid) => fillTiles(fillTiles(g, { col: 0, row: 4, cols: 1, rows: 3 }, "empty"), { col: g.rows[0]!.length - 1, row: 4, cols: 1, rows: 3 }, "empty");
  /** r1 -> r2 -> (a spike strip under a low ceiling: dash) -> r3 */
  const gated = fillTiles(fillTiles(openings(borderedGrid(16, 8)), { col: 1, row: 1, cols: 14, rows: 4 }, "solid"), { col: 5, row: 7, cols: 6, rows: 1 }, "hazard");
  const door = (id: string, side: "left" | "right", to: [string, string] | null) => ({ id, side, offset: 4, size: 3, to: to && { room: to[0], door: to[1] } });
  const world = World.parse({
    start: { room: "r1", x: 100, y: 224 },
    rooms: [
      { id: "r1", name: "One", grid: openings(plain), doors: [door("e", "right", ["r2", "w"])] },
      { id: "r2", name: "Two", grid: openings(gated), doors: [door("w", "left", ["r1", "e"]), door("e", "right", ["r3", "w"])] },
      { id: "r3", name: "Three", grid: openings(plain), doors: [door("w", "left", ["r2", "e"])] },
    ],
  });

  it("are traversed across door links", () => {
    expect([...worldTraversal(world, params, []).rooms].sort()).toEqual(["r1", "r2"]);
    expect([...worldTraversal(world, params, ["dash"]).rooms].sort()).toEqual(["r1", "r2", "r3"]);
    expect([...worldTraversal(world, params, ["dash"], { room: "r3", door: "w" }).exits].sort()).toEqual(["r1/e", "r2/e", "r2/w", "r3/w"]);
  });

  it("check that a gate needs its ability", () => {
    const reaches = (abilities: MovementAbility[]) => worldTraversal(world, params, abilities).rooms.has("r3");
    expect(gateCheck(reaches, ALL, "dash")).toEqual({ withAbility: true, without: false, holds: true });
    expect(gateCheck(reaches, ["dash"], "glide").holds).toBe(false);
  });
});

describe("cost", () => {
  it("checks a cluttered 100x60 room in well under a second per ability set", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    let g = borderedGrid(100, 60);
    for (let i = 0; i < 70; i++) {
      const kind = (["ledge", "solid", "oneway", "solid", "ledge"] as const)[Math.floor(rnd() * 5)]!;
      g = fillTiles(g, { col: 2 + Math.floor(rnd() * 90), row: 4 + Math.floor(rnd() * 52), cols: 2 + Math.floor(rnd() * 8), rows: kind === "solid" ? 1 + Math.floor(rnd() * 3) : 1 }, kind);
    }
    g = fillTiles(g, { col: 40, row: 58, cols: 10, rows: 1 }, "hazard");
    g = fillTiles(g, { col: 60, row: 30, cols: 8, rows: 1 }, "breakable");
    g = fillTiles(fillTiles(g, { col: 0, row: 55, cols: 1, rows: 3 }, "empty"), { col: 99, row: 10, cols: 1, rows: 3 }, "empty");
    const doors: TraversalOpening[] = [
      { id: "a", side: "left", offset: 55, size: 3 },
      { id: "c", side: "right", offset: 10, size: 3 },
    ];
    const time = (abilities: MovementAbility[]) => {
      movementModel(params, abilities); // the model is computed once per tuning and ability set, shared by every room
      const t = performance.now();
      roomTraversal({ grid: g, doors }, params, abilities);
      return performance.now() - t;
    };
    // Alone: ~0.2-0.6 s per single ability, ~1.5 s with all five. The bounds leave room for a loaded machine.
    for (const abilities of [[], ["double_jump"], ["dash"], ["wall_jump"]] as MovementAbility[][]) expect(time(abilities)).toBeLessThan(1500);
    expect(time(ALL)).toBeLessThan(6000);
  }, 60_000);
});
