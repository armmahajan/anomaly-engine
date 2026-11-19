import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyOperation, createDefaultProject, toRuntimeProject, type OperationResult, type ProjectSpec } from "@anomaly/core";

// An enemy's held weapon (weapon_view.gd) is in its hand from the start, and goes with it when it teleports.
const GAME_DIR = join(import.meta.dirname, "..");

interface Frame { enemy: boolean; center?: [number, number]; hidden?: boolean; weapon?: string; shown?: boolean; hold?: [number, number] }

function ok(r: OperationResult): ProjectSpec {
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}

function project(): ProjectSpec {
  let p = ok(applyOperation(createDefaultProject(), "createWeapon", { id: "blade", name: "Blade" }));
  p = ok(applyOperation(p, "setWeaponAttack", { weaponId: "blade", attack: { id: "cut", name: "Cut", shape: { type: "arc", radius: 60 } } }));
  // Wait, teleport behind the player, then swing; again and again.
  const behavior = {
    initial: "wait",
    states: {
      wait: { action: { type: "wait" }, transitions: [{ when: { type: "after", seconds: 0.4 }, to: "blink" }] },
      blink: { action: { type: "teleport", to: "behindPlayer", range: 200, windup: 0.3 }, transitions: [{ when: { type: "actionDone" }, to: "swing" }] },
      swing: { action: { type: "useWeapon", weapon: "blade" }, transitions: [{ when: { type: "actionDone" }, to: "wait" }] },
    },
    interrupts: [],
  };
  p = ok(applyOperation(p, "setBehavior", { characterId: "charger", behavior }));
  return ok(applyOperation(p, "removeRoomSpawn", { roomId: "arena", spawnId: "crawler_1" }));
}

function probe(p: ProjectSpec, frames: number): Frame[] {
  const dir = mkdtempSync(join(tmpdir(), "anomaly-enemy-weapon-"));
  try {
    writeFileSync(join(dir, "in.json"), JSON.stringify({ project: toRuntimeProject(p), frames }));
    execFileSync(process.env.GODOT ?? "godot", ["--headless", "--fixed-fps", "60", "--path", GAME_DIR, "--script", "res://tests/enemy_weapon_probe.gd", "--", join(dir, "in.json"), join(dir, "out.json")], { stdio: "pipe", timeout: 60_000 });
    const out = JSON.parse(readFileSync(join(dir, "out.json"), "utf8")) as { error: string; frames: Frame[] };
    if (out.error) throw new Error(out.error);
    return out.frames;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe("an enemy's held weapon (headless runtime)", () => {
  const frames = probe(project(), 90).filter((f) => f.enemy);

  it("is in its hand from the start, before it first attacks", () => {
    const first = frames.slice(2, 10);
    expect(first.length).toBeGreaterThan(0);
    for (const f of first) {
      expect(f.weapon).toBe("blade");
      expect(f.shown).toBe(true);
      expect(dist(f.hold!, f.center!)).toBeLessThan(60);
    }
  });

  it("vanishes while it teleports and is back in its hand where it reappears", () => {
    const hidden = frames.filter((f) => f.hidden);
    expect(hidden.length).toBeGreaterThan(0);
    for (const f of hidden) expect(f.shown).toBe(false);
    const back = frames.findIndex((f, i) => i > 0 && frames[i - 1]!.hidden && !f.hidden);
    expect(back).toBeGreaterThan(0);
    for (const f of frames.slice(back, back + 5)) {
      expect(f.shown).toBe(true);
      expect(dist(f.hold!, f.center!)).toBeLessThan(60); // at the new spot, not where it vanished
    }
  });
});
