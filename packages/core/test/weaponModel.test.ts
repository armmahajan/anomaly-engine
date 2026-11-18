import { describe, expect, it } from "vitest";
import { AIM_VECTORS, attackBounds, attackFrames, phaseAt, pickAttack, Weapon } from "../src/index.ts";

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

  it("reach: an arc's bounds are its radius around the aim", () => {
    const b = attackBounds({ shape: { type: "arc", radius: 60, from: -90, to: 90 }, timing: { windup: 0, active: 0.1, recovery: 0 }, cooldown: 0 }, AIM_VECTORS.forward, { width: 28, height: 44 })!;
    expect(b[2]).toBeCloseTo(60, 1);
    expect(b[1]).toBeCloseTo(-60, 1);
    expect(b[3]).toBeCloseTo(60, 1);
    expect(b[0]).toBeCloseTo(0, 1);
  });
});
