import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The HUD's health pips wrap into rows that stay left of the centred enemy health bars (hud.gd).
const GAME_DIR = join(import.meta.dirname, "..");

describe("HUD health pips", () => {
  it("fit as many per row as stay clear of the enemy health bars, 5 to 10", () => {
    const dir = mkdtempSync(join(tmpdir(), "anomaly-hud-"));
    try {
      execFileSync(process.env.GODOT ?? "godot", ["--headless", "--path", GAME_DIR, "--script", "res://tests/hud_probe.gd", "--", join(dir, "out.json")], { stdio: "pipe", timeout: 60_000 });
      const out = JSON.parse(readFileSync(join(dir, "out.json"), "utf8")) as Record<string, number>;
      // Bars are 360 wide and centred: at 960 the left 300 px hold (300 - 40) / 26 = 10 pips; narrower views hold fewer.
      expect(out).toEqual({ "640": 5, "960": 10, "1280": 10, "1920": 10 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
