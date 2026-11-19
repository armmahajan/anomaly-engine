import { describe, expect, it } from "vitest";
import {
  AIM_VECTORS,
  aimAt,
  aimBucket,
  aimRayReach,
  attackAim,
  attackBounds,
  attackFrames,
  attackHits,
  fanHeadings,
  frontDistance,
  phaseAt,
  pickAttack,
  triggerAims,
  Weapon,
  wielderAim,
} from "../src/index.ts";

// The weapon model (combat/weaponModel.ts), which the runtime mirrors (game/test/weapons.test.ts plays it).

const weapon = Weapon.parse({
  id: "w",
  name: "W",
  attacks: [
    { id: "b", name: "B", shape: { type: "arc", radius: 60 } },
    { id: "a", name: "A", shape: { type: "arc", radius: 60 }, combo: { next: "b" } },
    { id: "up", name: "Up", trigger: { aim: "up" }, shape: { type: "thrust", length: 80 } },
    { id: "any", name: "Any", trigger: { aim: "any", where: "air" }, shape: { type: "box", width: 30, height: 30 } },
    { id: "charged", name: "Charged", trigger: { hold: 0.5 }, shape: { type: "arc", radius: 90 } },
    { id: "big", name: "Big", trigger: { hold: 1 }, shape: { type: "arc", radius: 120 } },
  ],
});

describe("weapon model", () => {
  it("phases run windup, active (at least a frame), recovery in whole frames", () => {
    const f = attackFrames({ timing: { windup: 0.05, active: 0, recovery: 0.1 }, cooldown: 0.2 });
    expect(f).toEqual({ windup: 3, active: 1, recovery: 6, cooldown: 12, total: 10 });
    expect([0, 2, 3, 4, 9, 10].map((k) => phaseAt(f, k))).toEqual(["windup", "windup", "active", "recovery", "recovery", ""]);
  });

  it("a press picks a non-combo attack first, an exact aim over any, and down only in the air; a release the longest hold reached", () => {
    expect(pickAttack(weapon, "forward", false, null)?.id).toBe("a");
    expect(pickAttack(weapon, "up", false, null)?.id).toBe("up");
    expect(pickAttack(weapon, "down", false, null)?.id).toBe("a"); // on the ground, down is forward
    expect(pickAttack(weapon, "down", true, null)?.id).toBe("any");
    expect(pickAttack(weapon, "forward", false, 0.3)).toBeNull();
    expect(pickAttack(weapon, "forward", false, 0.7)?.id).toBe("charged");
    expect(pickAttack(weapon, "forward", false, 1.2)?.id).toBe("big");
  });

  it("mouse aims pick by bucket: within 45° of straight up is up, of straight down down (in the air only), else forward", () => {
    expect([-90, -100, -135, -45].map((d) => aimBucket(aimAt(d)))).toEqual(["up", "up", "up", "up"]);
    expect([-44, 0, 44, 136, 180, -136].map((d) => aimBucket(aimAt(d)))).toEqual(["forward", "forward", "forward", "forward", "forward", "forward"]);
    expect([45, 90, 120, 135].map((d) => aimBucket(aimAt(d)))).toEqual(["down", "down", "down", "down"]);
    expect(pickAttack(weapon, aimAt(-100), false, null)?.id).toBe("up");
    expect(pickAttack(weapon, aimAt(-30), false, null)?.id).toBe("a");
    expect(pickAttack(weapon, aimAt(150), false, null)?.id).toBe("a");
    expect(pickAttack(weapon, aimAt(100), false, null)?.id).toBe("a"); // down on the ground is forward
    expect(pickAttack(weapon, aimAt(100), true, null)?.id).toBe("any");
    expect(pickAttack(weapon, aimAt(-30), false, 1.2)?.id).toBe("big"); // holds go by hold first, as with keys
  });

  it("the wielder turns toward a mouse aim; the shape follows it exactly, a key aim as the trigger says", () => {
    const left = wielderAim(aimAt(150), 1);
    expect(left.facing).toBe(-1);
    expect(left.aim.x).toBeCloseTo(Math.cos(Math.PI / 6), 9);
    expect(left.aim.y).toBeCloseTo(0.5, 9);
    expect(wielderAim(aimAt(-90), -1).facing).toBe(-1); // straight up keeps the way it faces
    const up = weapon.attacks.find((a) => a.id === "up")!;
    const any = weapon.attacks.find((a) => a.id === "any")!;
    expect(attackAim(up, aimAt(-60), false)).toEqual(aimAt(-60));
    expect(attackAim(up, "forward", false)).toBe(AIM_VECTORS.up);
    expect(attackAim(any, "down", false)).toBe(AIM_VECTORS.forward);
    expect(attackAim(any, "down", true)).toBe(AIM_VECTORS.down);
  });

  it("every shape turns with an off-axis aim (30°, 150° mirrored, -120°): it covers its reach along the aim and nothing past it", () => {
    const body = { width: 28, height: 44 };
    const timing = { windup: 0, active: 0.1, recovery: 0 };
    const shapes = {
      arc: { shape: { type: "arc", radius: 80, from: -90, to: 90 }, reach: 80 },
      box: { shape: { type: "box", width: 40, height: 30, offset: [0, 0] }, reach: null },
      thrust: { shape: { type: "thrust", length: 90, width: 20 }, reach: 90 },
    } as const;
    for (const deg of [30, 150, -120]) {
      const { aim } = wielderAim(aimAt(deg), 1);
      for (const [name, s] of Object.entries(shapes)) {
        const attack = { shape: s.shape, timing, cooldown: 0 } as Parameters<typeof attackHits>[0];
        const reach = s.reach ?? frontDistance(aim, body) + 20;
        const at = (d: number): [number, number, number, number] => [aim.x * d - 1, aim.y * d - 1, aim.x * d + 1, aim.y * d + 1];
        expect(attackHits(attack, aim, body, at(reach - 2)), `${name} at ${deg}°`).toBe(true);
        expect(attackHits(attack, aim, body, at(reach + 2)), `${name} at ${deg}°`).toBe(false);
        // The checker's sure reach along the aim: inside the shape, out to (nearly) its reach.
        const sure = aimRayReach(attack, aim, body);
        const far = Math.max(...sure.map((b) => Math.max(Math.abs(b[0]), Math.abs(b[2]), Math.abs(b[1]), Math.abs(b[3]))));
        expect(far, `${name} at ${deg}°`).toBeLessThanOrEqual(reach + 1e-6);
        expect(sure.some((b) => attackHits(attack, aim, body, b) && b[0] <= aim.x * (reach - 4) && aim.x * (reach - 4) <= b[2] + 1e-9), `${name} at ${deg}°`).toBe(true);
      }
      const heading = fanHeadings({ count: 1, spread: 0 }, aim)[0]!;
      expect(Math.cos(heading)).toBeCloseTo(aim.x, 9);
      expect(Math.sin(heading)).toBeCloseTo(aim.y, 9);
    }
  });

  it("with mouse aiming an attack is used across its buckets' ranges: up the upper 90°, down only in the air", () => {
    const up = weapon.attacks.find((a) => a.id === "up")!;
    const any = weapon.attacks.find((a) => a.id === "any")!;
    expect(triggerAims(up, "ground")).toEqual([AIM_VECTORS.up]);
    const ups = triggerAims(up, "ground", true);
    expect(ups.every((v) => aimBucket(v) === "up")).toBe(true);
    expect(ups).toContain(AIM_VECTORS.up);
    expect(Math.min(...ups.map((v) => v.x))).toBeCloseTo(0, 9);
    expect(Math.max(...ups.map((v) => v.x))).toBeCloseTo(Math.SQRT1_2, 9);
    const air = triggerAims(any, "air", true).map(aimBucket);
    expect(new Set(air)).toEqual(new Set(["up", "forward", "down"]));
    expect(triggerAims({ trigger: { ...any.trigger, where: "both" } }, "ground", true).map(aimBucket)).not.toContain("down");
  });

  it("reach: an arc's bounds are its radius around the aim", () => {
    const b = attackBounds({ shape: { type: "arc", radius: 60, from: -90, to: 90 }, timing: { windup: 0, active: 0.1, recovery: 0 }, cooldown: 0 }, AIM_VECTORS.forward, { width: 28, height: 44 })!;
    expect(b[2]).toBeCloseTo(60, 1);
    expect(b[1]).toBeCloseTo(-60, 1);
    expect(b[3]).toBeCloseTo(60, 1);
    expect(b[0]).toBeCloseTo(0, 1);
  });
});
