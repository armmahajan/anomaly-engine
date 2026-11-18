import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ARENA_FLOOR, createDefaultProject, ProjectSpec, toRuntimeProject, type EntityState, type GridSolid, type WorldStart } from "@anomaly/core";

const GAME_DIR = fileURLToPath(new URL("..", import.meta.url));
export const FPS = 60;

export interface Scenario {
  project: ProjectSpec;
  /** Collision to use instead of the playtest room grid's (for exact, non-tile geometry in physics tests). */
  solids?: GridSolid[];
  seed?: number;
  /** Start here (as the play message's `world`) instead of the playtest. */
  world?: WorldStart;
  frames: number;
  samples: number[];
  input?: { action: Input; from: number; to: number }[];
}

export type Input = "move_left" | "move_right" | "jump" | "attack" | "alt_attack" | "special_attack" | "weapon_cycle" | "aim_up" | "aim_down" | "dash" | "interact" | "map";

export interface Sample {
  frame: number;
  deaths: number;
  /** World play: the current room, its respawn point [x, y] and the rooms visited (null / [] in the arena). */
  room: string | null;
  entry: [number, number] | null;
  visited: string[];
  entities: EntityState[];
  /** The run's state (see protocol.ts "state"). */
  flags: string[];
  items: Record<string, number>;
  abilities: string[];
  checkpoint: { room: string; x: number; y: number } | null;
  modal: string | null;
  mapOpen: boolean;
  healthBars: string[];
  props: { id: string; visible: boolean; solid: boolean }[];
  /** Weapons the player has, what each loadout slot holds, and the HUD's weapon rows (null outside a run). */
  weapons: { owned: string[]; slots: Record<string, string>; hud: { slot: string; label: string; weapon: string; name: string; ammo: Record<string, number> }[] } | null;
}

/** Run scenarios in one headless Godot process, 1/60 s per frame. */
export function simulate(scenarios: Scenario[]): Sample[][] {
  const dir = mkdtempSync(join(tmpdir(), "anomaly-sim-"));
  try {
    const runtime = scenarios.map(({ solids, project, ...rest }) => {
      const sent = toRuntimeProject(project);
      const room = sent.world.rooms.find((r) => r.id === project.world.playtest?.room);
      if (solids && room) room.solids = solids;
      return { ...rest, project: sent };
    });
    writeFileSync(join(dir, "in.json"), JSON.stringify({ scenarios: runtime }));
    execFileSync(
      process.env.GODOT ?? "godot",
      ["--headless", "--fixed-fps", String(FPS), "--path", GAME_DIR, "--script", "res://tests/simulate.gd", "--", join(dir, "in.json"), join(dir, "out.json")],
      { stdio: "pipe", timeout: 60_000 },
    );
    const { results } = JSON.parse(readFileSync(join(dir, "out.json"), "utf8")) as {
      results: { error: string; samples: Sample[] }[];
    };
    return results.map((r, i) => {
      if (r.error) throw new Error(`scenario ${i}: ${r.error}`);
      return r.samples;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const range = (from: number, to: number, step = 1) =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

type Step = [condition: Record<string, unknown>, to: string];
export interface EnemySetup {
  id: string;
  at: [number, number];
  movement?: "ground" | "flying";
  initial: string;
  states: Record<string, { action: Record<string, unknown>; go?: Step[] }>;
  interrupts?: Step[];
  count?: number;
  stats?: { knockback?: number; health?: number; contactDamage?: number };
}

/** The default arena room (floor top y=672; a ledge at x 384-608 y 544, a breakable block at x 736-928 y 416) with the given enemies, as the playtest. */
export function arena(enemies: EnemySetup[], player: [number, number] = [160, ARENA_FLOOR], abilities: string[] = []): ProjectSpec {
  const base = createDefaultProject();
  const toTransitions = (steps: Step[] = []) => steps.map(([when, to]) => ({ when, to }));
  return ProjectSpec.parse({
    ...base,
    characters: [
      base.characters[0],
      ...enemies.map((e) => ({
        id: e.id,
        kind: "enemy",
        name: e.id,
        color: "#888888",
        size: { width: 32, height: 32 },
        stats: { knockback: 0, contactDamage: 0, ...e.stats },
        movement: e.movement ?? "ground",
        behavior: {
          initial: e.initial,
          states: Object.fromEntries(
            Object.entries(e.states).map(([id, s]) => [id, { action: s.action, transitions: toTransitions(s.go) }]),
          ),
          interrupts: toTransitions(e.interrupts),
        },
      })),
    ],
    world: {
      ...base.world,
      rooms: [
        {
          ...base.world.rooms[0]!,
          spawns: enemies.flatMap((e) => range(1, e.count ?? 1).map((n) => ({ id: `${e.id}_${n}`, characterId: e.id, x: e.at[0], y: e.at[1] }))),
        },
      ],
      playtest: { room: base.world.rooms[0]!.id, x: player[0], y: player[1], abilities },
    },
  });
}

/** `base` playtesting its first room, re-tiled with `grid` (and emptied of enemies), from `at`. */
export function playtestRoom(base: ProjectSpec, grid: { rows: string[] }, at: { x: number; y: number }, abilities: string[] = []): ProjectSpec {
  const room = { ...base.world.rooms[0]!, grid, spawns: [], doors: [] };
  return ProjectSpec.parse({ ...base, world: { ...base.world, rooms: [room], start: null, playtest: { room: room.id, ...at, abilities } } });
}

export function entity(sample: Sample | undefined, spawnId: string): EntityState {
  const found = sample?.entities.find((e) => e.spawnId === spawnId);
  if (!found) throw new Error(`no ${spawnId} at frame ${sample?.frame}`);
  return found;
}

export const at = (samples: Sample[], frame: number) => samples.find((s) => s.frame === frame);
