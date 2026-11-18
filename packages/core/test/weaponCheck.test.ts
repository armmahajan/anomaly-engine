import { describe, expect, it } from "vitest";
import { borderedGrid, checkGame, fillTiles, fixtureSliceProject, ProjectSpec, TILE, type CheckResult } from "../src/index.ts";

// The checker with weapons (world/logic/check.ts): the weapons the player has are part of the
// state (the loadout's start weapons from the start, giveWeapon / takeWeapon after), a barrier
// that needs a weapon opens only once the player has it, and what can be struck depends on the
// weapons' reach (down strikes included: where the pogo is).

const show = (r: CheckResult) => r.deadStates.map((d) => `${d.why}\n  ${d.path.map((s) => s.action).join("\n  ")}`).join("\n");
const spear = { id: "spear", name: "Spear", attacks: [{ id: "down", name: "Down", trigger: { aim: "down" }, shape: { type: "thrust", length: 150 } }] };
const blade = { id: "blade", name: "Blade", attacks: [{ id: "cut", name: "Cut", shape: { type: "arc", radius: 60 } }] };
const loadout = (start: string | null) => ({ slots: [{ id: "main", label: "Main", action: "attack", start }] });

/** The slice with a barrier across the hall, solid while the player has no blade (the Architect's weapon gate). */
function gated(opts: { start?: string | null; giver?: boolean } = {}): ProjectSpec {
  const base = fixtureSliceProject();
  const rooms = base.world.rooms.map((r) => {
    if (r.id === "hall") {
      return { ...r, props: [...r.props, { id: "barrier", name: "Barrier", x: 3 * TILE, y: TILE, width: TILE, height: 11 * TILE, solid: { type: "not", of: { type: "weapon", weapon: "blade" } }, handlers: [] }] };
    }
    if (r.id === "entrance" && opts.giver) {
      return { ...r, props: [...r.props, { id: "rack", name: "Weapon rack", x: 6 * TILE, y: 11 * TILE, width: TILE, height: TILE, handlers: [{ on: { type: "touch" }, do: [{ type: "giveWeapon", weapon: "blade" }] }] }] };
    }
    return r;
  });
  return ProjectSpec.parse({ ...base, weapons: { list: [blade], loadout: loadout(opts.start ?? null) }, world: { ...base.world, rooms } });
}

/** One room: a floor four tiles deep with a crate buried in it (only a long downward strike reaches it); breaking it ends the game. */
function buried(weapons: object[], start: string | null): ProjectSpec {
  const base = fixtureSliceProject();
  const grid = fillTiles(borderedGrid(20, 18), { col: 1, row: 14, cols: 18, rows: 3 }, "solid");
  const crate = { id: "crate", name: "Crate", x: 10 * TILE, y: 14 * TILE + 72, width: TILE, height: 20, health: 1, handlers: [{ on: { type: "destroyed" }, do: [{ type: "endGame" }] }] };
  return ProjectSpec.parse({
    ...base,
    weapons: { list: weapons, loadout: loadout(start) },
    world: { ...base.world, rooms: [{ id: "pit", name: "Pit", at: { x: 0, y: 0 }, grid, doors: [], props: [crate] }], start: { room: "pit", x: 3 * TILE, y: 14 * TILE }, playtest: null, handlers: [], modals: [] },
  });
}

describe("checking a game with weapons", () => {
  it("a barrier that needs a weapon nothing gives blocks the way, and says so", () => {
    const r = checkGame(gated());
    expect(r.beatable).toBe(false);
    expect(r.deadStates[0]!.why).toMatch(/weapon blade/);
  });

  it("a weapon the loadout starts with is held from the start: the barrier is open", () => {
    const r = checkGame(gated({ start: "blade" }));
    expect(show(r)).toBe("");
    expect(r.beatable).toBe(true);
  });

  it("a weapon given on the way opens it once taken (never before)", () => {
    const r = checkGame(gated({ giver: true }));
    expect(show(r)).toBe("");
    const route = r.route!.map((s) => `${s.room}: ${s.action}`);
    const took = route.indexOf("entrance: touch Weapon rack");
    expect(took).toBeGreaterThanOrEqual(0);
    expect(route.findIndex((s) => s.startsWith("hall:"))).toBeGreaterThan(took);
    expect(r.route!.at(-1)!.memory.flags).toContain("weapon:blade");
  });

  it("what can be struck follows the weapons held: a long down strike (the pogo's reach) breaks what the built-in attack can't", () => {
    expect(checkGame(buried([], null)).beatable).toBe(false);
    expect(checkGame(buried([spear], null)).beatable).toBe(false); // in the game, but never held
    const r = checkGame(buried([spear], "spear"));
    expect(show(r)).toBe("");
    expect(r.route!.some((s) => s.action.startsWith("strike Crate"))).toBe(true);
  });
});
