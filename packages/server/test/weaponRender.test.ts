import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Clip, defaultArtDirection, Rig, Weapon, type WeaponAttack } from "@anomaly/core";
import { attackTiming, decodePng, encodePng, fitWeaponClip, humanoidRig, withHandGrip, type Pixels } from "@anomaly/art";
import { BrowserRenderer } from "../src/art/renderer.ts";

/**
 * The held weapon in the real runtime (weapon_view.gd via the web export): across every frame of a
 * walk and of an attack clip, the sprite's grip stays on the rig's hand grip. The rig marks its grip
 * with a cyan dot; the sprite's grip is the centre of a magenta ring with a hole, so both show.
 */

const exportDir = fileURLToPath(new URL("../../../apps/studio/public/game", import.meta.url));
const hasExport = existsSync(join(exportDir, "index.html"));

const SPRITE = `${"c".repeat(32)}.png`;
const FRAMES = 12;
const CELL = 256;

/** 64x16: a magenta ring (hole radius 4) around the grip at (8, 8), then a grey bar to the tip. */
function ringSprite(): Pixels {
  const width = 64;
  const height = 16;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x + 0.5 - 8, y + 0.5 - 8);
      if (d >= 4.5 && d <= 7.5) data.set([255, 0, 255, 255], (y * width + x) * 4);
      else if (x >= 16 && y >= 6 && y < 10) data.set([128, 128, 128, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

const swing: WeaponAttack = {
  id: "swing",
  name: "Swing",
  trigger: { aim: "forward", where: "both", hold: 0 },
  shape: { type: "arc", radius: 50, from: -70, to: 50 },
  damage: 1,
  knockback: 350,
  timing: { windup: 0.1, active: 0.12, recovery: 0.2 },
  cooldown: 0.2,
  movement: { lunge: 0, recoil: 0, pogo: false },
  combo: { next: null, window: 0.35 },
  ammo: null,
  hitStop: 0.05,
  shake: 0,
  clip: null,
};

/** Centroid of the pixels a test picks, inside one cell. */
function centroid(px: Pixels, cell: number, columns: number, pick: (r: number, g: number, b: number) => boolean): [number, number] | null {
  const x0 = (cell % columns) * CELL;
  const y0 = Math.floor(cell / columns) * CELL;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = y0; y < y0 + CELL; y++) {
    for (let x = x0; x < x0 + CELL; x++) {
      const i = (y * px.width + x) * 4;
      if (pick(px.data[i]!, px.data[i + 1]!, px.data[i + 2]!)) (sx += x, sy += y, n++);
    }
  }
  return n > 0 ? [sx / n, sy / n] : null;
}

describe.skipIf(!hasExport || process.env.SKIP_BROWSER_TESTS === "1")("held weapon (weapon_view.gd in the web export)", () => {
  it("keeps the sprite's grip within 4 px of the rig's hand grip across a walk and an attack", async () => {
    const base = withHandGrip(humanoidRig());
    const grip = base.grips![0]!;
    const rig = Rig.parse({
      ...base,
      parts: [...base.parts, { id: "grip_mark", bone: grip.bone, z: 30, shape: { type: "ellipse", center: grip.at, rx: 0.9, ry: 0.9 }, fill: "#00ffff", ink: 0 }],
    });
    const walk = Clip.parse({
      duration: 0.8,
      loop: true,
      motions: [
        { type: "sway", bone: "arm_near_upper", degrees: 30 },
        { type: "sway", bone: "arm_near_lower", degrees: 20, phase: 0.25 },
        { type: "sway", bone: "leg_front", degrees: 25 },
        { type: "sway", bone: "leg_back", degrees: 25, phase: 0.5 },
        { type: "bob", bone: "body", amount: 1.5, cycles: 2 },
      ],
    });
    const attack = fitWeaponClip(rig, grip, swing, Clip.parse({ duration: attackTiming(swing).duration, loop: false, motions: [{ type: "bob", bone: "body", amount: 1, cycles: 1 }] }));
    const weapon = Weapon.parse({ id: "blade", name: "Blade", attacks: [swing], art: { sprite: SPRITE, grip: [8, 8], tip: [63, 8], scale: 0.5, trail: { color: "#ffff00", width: 6, seconds: 0.1 } } });
    const columns = 6;
    const yellow = (r: number, g: number, b: number) => r > 200 && g > 200 && b < 60;
    const renderer = new BrowserRenderer(exportDir);
    try {
      const render = async (clip: string, duration: number, out?: string) => {
        const frames = Array.from({ length: FRAMES }, (_, i) => ({ clip, time: (duration * i) / (clip === "walk" ? FRAMES : FRAMES - 1) }));
        const image = await renderer.renderRig({
          rig,
          direction: { ...defaultArtDirection(), boil: 0 },
          clips: { walk, blade_swing: attack },
          frames,
          cellWidth: CELL,
          cellHeight: CELL,
          columns,
          background: "#000000",
          images: { [SPRITE]: encodePng(ringSprite()).toString("base64") },
          weapon: { weapon, attack: "swing" },
        });
        expect(image.warnings).toEqual([]);
        if (out) writeFileSync(out, image.png);
        const px = decodePng(image.png);
        let worst = 0;
        for (let cell = 0; cell < FRAMES; cell++) {
          const hand = centroid(px, cell, columns, (r, g, b) => r < 60 && g > 200 && b > 200);
          const ring = centroid(px, cell, columns, (r, g, b) => r > 200 && g < 60 && b > 200);
          expect(hand, `${clip} frame ${cell}: the hand's mark`).not.toBeNull();
          expect(ring, `${clip} frame ${cell}: the sprite's grip ring`).not.toBeNull();
          worst = Math.max(worst, Math.hypot(hand![0] - ring![0], hand![1] - ring![1]) / image.scale);
        }
        return { px, frames, worst };
      };
      const out = process.env.WEAPON_RENDER_OUT;
      const walking = await render("walk", walk.duration, out && `${out}-walk.png`);
      const swinging = await render("blade_swing", attack.duration, out && `${out}-swing.png`);
      expect(walking.worst).toBeLessThanOrEqual(4);
      expect(swinging.worst).toBeLessThanOrEqual(4);
      // Only the attack's clip draws a trail, behind the tip in its active window.
      for (let cell = 0; cell < FRAMES; cell++) expect(centroid(walking.px, cell, columns, yellow), `walk frame ${cell} has no trail`).toBeNull();
      const { activeFrom, activeTo } = attackTiming(swing);
      const active = swinging.frames.findIndex((f) => f.time / attack.duration > activeFrom + 0.05 && f.time / attack.duration < activeTo);
      expect(active).toBeGreaterThan(0);
      expect(centroid(swinging.px, active, columns, yellow)).not.toBeNull();
      expect(centroid(swinging.px, 0, columns, yellow)).toBeNull();
    } finally {
      await renderer.close();
    }
  }, 120_000);
});
