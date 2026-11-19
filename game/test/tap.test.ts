import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultProject, toRuntimeProject } from "@anomaly/core";

// player.gd: a move key pressed and released between two frames still counts (it used to be lost).
const GAME_DIR = join(import.meta.dirname, "..");

describe("a quick tap of a move key", () => {
  it("turns the player and moves it, though the key was up again before the frame read it", () => {
    const dir = mkdtempSync(join(tmpdir(), "anomaly-tap-"));
    try {
      writeFileSync(join(dir, "in.json"), JSON.stringify({ project: toRuntimeProject(createDefaultProject()), settle: 30 }));
      execFileSync(process.env.GODOT ?? "godot", ["--headless", "--fixed-fps", "60", "--path", GAME_DIR, "--script", "res://tests/tap_probe.gd", "--", join(dir, "in.json"), join(dir, "out.json")], { stdio: "pipe", timeout: 60_000 });
      const out = JSON.parse(readFileSync(join(dir, "out.json"), "utf8")) as { before: { x: number; facing: number }; after: { x: number; facing: number } };
      expect(out.before.facing).toBe(1);
      expect(out.after.facing).toBe(-1);
      expect(out.after.x).toBeLessThan(out.before.x);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
