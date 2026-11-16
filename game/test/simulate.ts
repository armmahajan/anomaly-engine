import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultProject, ProjectSpec, type EntityState } from "@anomaly/core";

const GAME_DIR = fileURLToPath(new URL("..", import.meta.url));
export const FPS = 60;

export interface Scenario {
  project: ProjectSpec;
  seed?: number;
  frames: number;
  samples: number[];
  input?: { action: Input; from: number; to: number }[];
}

export type Input = "move_left" | "move_right" | "jump" | "attack" | "aim_up" | "aim_down";

export interface Sample {
  frame: number;
  deaths: number;
  entities: EntityState[];
}

/** Run scenarios in one headless Godot process, 1/60 s per frame. */
export function simulate(scenarios: Scenario[]): Sample[][] {
  const dir = mkdtempSync(join(tmpdir(), "anomaly-sim-"));
  try {
    writeFileSync(join(dir, "in.json"), JSON.stringify({ scenarios }));
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

/** The default arena (floor top y=660; platforms at x 380-600 y 530 and x 720-940 y 420) with the given enemies. */
export function arena(enemies: EnemySetup[], player: [number, number] = [160, 660]): ProjectSpec {
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
    sandbox: {
      ...base.sandbox,
      spawns: [
        { id: "player_1", characterId: "player", x: player[0], y: player[1] },
        ...enemies.flatMap((e) =>
          range(1, e.count ?? 1).map((n) => ({ id: `${e.id}_${n}`, characterId: e.id, x: e.at[0], y: e.at[1] })),
        ),
      ],
    },
  });
}

export function entity(sample: Sample | undefined, spawnId: string): EntityState {
  const found = sample?.entities.find((e) => e.spawnId === spawnId);
  if (!found) throw new Error(`no ${spawnId} at frame ${sample?.frame}`);
  return found;
}

export const at = (samples: Sample[], frame: number) => samples.find((s) => s.frame === frame);
