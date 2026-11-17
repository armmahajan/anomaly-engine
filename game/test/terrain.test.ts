import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createDefaultProject, gridToSolids, TILE, toRuntimeProject, type ProjectSpec } from "@anomaly/core";
import { FPS } from "./simulate.ts";

// The terrain drawer (game/scripts/terrain.gd), probed headless through game/tests/terrain_probe.gd.

const GAME_DIR = fileURLToPath(new URL("..", import.meta.url));

interface Drawn {
  cols: number;
  rows: number;
  ledge: number;
  cells: [number, number, string][];
  rims: [number, number][];
  edges: [number, number, string][];
  spikes: [number, number, string][];
  shapes: [number, number, number, number, string][];
}
interface Played {
  error: string;
  dressed: boolean;
  before: Drawn;
  after: Drawn;
}

function probe(cases: unknown[]): unknown[] {
  const dir = mkdtempSync(join(tmpdir(), "anomaly-terrain-"));
  try {
    writeFileSync(join(dir, "in.json"), JSON.stringify({ cases }));
    const run = spawnSync(
      process.env.GODOT ?? "godot",
      ["--headless", "--fixed-fps", String(FPS), "--path", GAME_DIR, "--script", "res://tests/terrain_probe.gd", "--", join(dir, "in.json"), join(dir, "out.json")],
      { encoding: "utf8", timeout: 60_000 },
    );
    const errors = `${run.stdout}${run.stderr}`.split("\n").filter((line) => /SCRIPT ERROR|^ERROR/.test(line));
    if (run.status !== 0 || errors.length) throw new Error(`terrain probe failed (${run.status}):\n${errors.join("\n")}`);
    return JSON.parse(readFileSync(join(dir, "out.json"), "utf8")).results;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** L-shapes, a ledge on a solid, one-way next to solid, a breakable group, a spike strip and a spike wall, an overhang. */
const TRICKY = [
  "##############",
  "#.....###....#",
  "#.....#......#",
  "#..==.#..---##",
  "#..##.....#.^#",
  "#..##..%%.#.^#",
  "#.......%%..^#",
  "#.^^.........#",
  "##############",
];

const kind = (rows: string[], c: number, r: number) => (r < 0 || c < 0 || r >= rows.length || c >= rows[0]!.length ? "#" : rows[r]![c]!);
const full = (ch: string) => "#^%".includes(ch);
const key = (...xs: unknown[]) => xs.join(",");

/** Where rims belong: every exposed top (the cell above is empty or thin; outside the grid counts as solid), hazards excepted. */
function expectedRims(rows: string[]): string[] {
  const out: string[] = [];
  rows.forEach((row, r) => [...row].forEach((ch, c) => ch !== "." && ch !== "^" && !full(kind(rows, c, r - 1)) && out.push(key(c, r))));
  return out.sort();
}

/** Every drawn shape lies inside the solid part of the cells it covers (full cells, or the top `ledge` px of thin ones). */
function outside(drawn: Drawn, rows: string[]): string[] {
  const bad: string[] = [];
  for (const [x, y, w, h, tag] of drawn.shapes) {
    for (let r = Math.floor(y / TILE); r * TILE < y + h - 1e-3; r++) {
      for (let c = Math.floor(x / TILE); c * TILE < x + w - 1e-3; c++) {
        const ch = kind(rows, c, r);
        const bottom = ch === "=" || ch === "-" ? r * TILE + drawn.ledge : (r + 1) * TILE;
        const overlaps = Math.min(x + w, (c + 1) * TILE) - Math.max(x, c * TILE) > 1e-3 && Math.min(y + h, (r + 1) * TILE) - Math.max(y, r * TILE) > 1e-3;
        if (overlaps && (ch === "." || y + h > bottom + 1e-3)) bad.push(`${tag} at ${key(x, y, w, h)} over ${ch} ${key(c, r)}`);
      }
    }
  }
  return bad;
}

/** The starter arena, the player on its breakable block, ground pounding through it. */
function smashRun(dressed: boolean) {
  const base = createDefaultProject();
  const project: ProjectSpec = {
    ...base,
    sandbox: {
      ...base.sandbox,
      playerAbilities: ["ground_pound"],
      spawns: base.sandbox.spawns.filter((s) => s.characterId === "player").map((s) => ({ ...s, x: 832, y: 416 })),
    },
  };
  const sent = toRuntimeProject(project);
  if (dressed) {
    sent.sandbox.dressing = { biome: "cave", room: "hall" };
    (sent.art.assets as unknown[]).push({ // just what the runtime reads
      id: "cave",
      kind: "biome",
      kit: { backdrop: "backdrop.png", ground: "ground.png", pieces: [] },
      rooms: [
        {
          id: "hall",
          name: "Hall",
          composition: {
            palette: { ambient: "#8090a0", fog: "#33465a", light: "#ffd9a0", shadow: "#05070a" },
            placements: [],
            lights: [],
            fog: { mid: 0.2, back: 0.2, play: 0.1 },
            rays: [{ x: 800, width: 200, angle: 15, alpha: 0.3 }],
            dust: { color: "#ffffff", amount: 20 },
          },
        },
      ],
    });
  }
  const span = (action: string, from: number, to: number) => ({ action, from, to });
  return {
    project: sent,
    frames: 80,
    input: [span("jump", 2, 10), span("aim_down", 5, 30), span("jump", 12, 14)],
    textures: dressed ? ["backdrop.png", "ground.png"] : [],
  };
}

describe("terrain", () => {
  const arena = createDefaultProject().sandbox.grid.rows;
  let drawn: { arena: Drawn; tricky: Drawn; thin: Drawn; plain: Played; dressed: Played; rebuilt: { rows: string[]; ledge: number } };

  beforeAll(() => {
    const [a, t, thin, plain, dressed, rebuilt] = probe([
      { rows: arena, ledge: 20 },
      { rows: TRICKY, ledge: 20 },
      { rows: TRICKY, ledge: 12 },
      smashRun(false),
      smashRun(true),
      { solids: gridToSolids({ rows: TRICKY }, 12) },
    ]);
    drawn = { arena: a as Drawn, tricky: t as Drawn, thin: thin as Drawn, plain: plain as Played, dressed: dressed as Played, rebuilt: rebuilt as never };
  }, 120_000);

  it("fills every non-empty cell, and nothing else", () => {
    for (const [name, rows] of [["arena", arena], ["tricky", TRICKY]] as const) {
      const expected = rows.flatMap((row, r) => [...row].flatMap((ch, c) => (ch === "." ? [] : [key(c, r)])));
      expect(drawn[name].cells.map(([c, r]) => key(c, r)).sort(), name).toEqual(expected.sort());
      expect(outside(drawn[name], rows), name).toEqual([]);
    }
    expect(drawn.tricky.cells.find(([c, r]) => c === 7 && r === 5)?.[2]).toBe("breakable");
  });

  it("puts rims exactly on exposed tops", () => {
    expect(drawn.arena.rims.map(([c, r]) => key(c, r)).sort()).toEqual(expectedRims(arena));
    expect(drawn.tricky.rims.map(([c, r]) => key(c, r)).sort()).toEqual(expectedRims(TRICKY));
    // The ledge on the solid block: both the plank and the block under it are lit.
    expect(drawn.tricky.rims).toEqual(expect.arrayContaining([[3, 3], [3, 4]]));
  });

  it("draws no edge between two solid cells", () => {
    const across = { left: [-1, 0], right: [1, 0], bottom: [0, 1], top: [0, -1] } as Record<string, [number, number]>;
    for (const [name, rows] of [["arena", arena], ["tricky", TRICKY]] as const) {
      for (const [c, r, side] of [...drawn[name].edges, ...drawn[name].spikes]) {
        if (side === "underside") continue; // a plank's, inside its own cell
        const [dc, dr] = across[side]!;
        expect(full(kind(rows, c + dc, r + dr)), `${name} ${key(c, r, side)}`).toBe(false);
      }
    }
    // Exposed sides get their edges: the hanging wall's sides and underside, the block under the one-way.
    const tricky = drawn.tricky.edges.map((e) => key(...e));
    expect(tricky).toEqual(expect.arrayContaining([key(6, 2, "left"), key(6, 2, "right"), key(6, 3, "bottom"), key(10, 4, "left"), key(10, 4, "right"), key(3, 3, "underside")]));
    expect(drawn.tricky.spikes.map((s) => key(...s)).sort()).toEqual([key(2, 7, "top"), key(3, 7, "top"), key(12, 4, "left"), key(12, 5, "left"), key(12, 6, "bottom")].sort());
  });

  it("draws ledges and one-ways at the ledge thickness", () => {
    for (const d of [drawn.tricky, drawn.thin]) {
      const thin = d.shapes.filter(([x, y]) => "=-".includes(kind(TRICKY, Math.floor(x / TILE), Math.floor(y / TILE))));
      expect(thin.length).toBeGreaterThan(0);
      expect(Math.max(...thin.map(([, y, , h]) => (y % TILE) + h))).toBeCloseTo(d.ledge);
      expect(outside(d, TRICKY)).toEqual([]);
    }
    expect(drawn.thin.ledge).toBe(12);
  });

  it("rebuilds the grid from collision rectangles (callers without one)", () => {
    expect(drawn.rebuilt).toMatchObject({ rows: TRICKY, ledge: 12 });
  });

  it("clears the smashed cells after a ground pound, plain and dressed", () => {
    const breakables = (d: Drawn) => d.cells.filter(([, , k]) => k === "breakable").map(([c, r]) => key(c, r));
    for (const run of [drawn.plain, drawn.dressed]) {
      expect(run.error).toBe("");
      expect(breakables(run.before)).toEqual(["23,13", "24,13", "25,13", "26,13", "27,13", "28,13"]);
      expect(breakables(run.after)).toEqual([]);
      expect(run.after.cells).toHaveLength(run.before.cells.length - 6);
    }
    expect([drawn.plain.dressed, drawn.dressed.dressed]).toEqual([false, true]);
  });
});
