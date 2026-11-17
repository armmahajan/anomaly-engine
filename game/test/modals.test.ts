import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { applyOperation, ARENA_FLOOR, fixtureProject, ProjectSpec, toRuntimeProject } from "@anomaly/core";
import { arena, entity, FPS, type Input, type Sample, type Scenario } from "./simulate.ts";

// Modals and the map (game/scripts/modal.gd, map_view.gd) in the real runtime,
// probed headless through game/tests/modal_probe.gd. Title screens, endings and
// credits are only data here: modals shown by handlers and buttons.

const GAME_DIR = fileURLToPath(new URL("..", import.meta.url));
type Screen = {
  modal: { id: string; title: string; body: string; buttons: string[]; selected: number; image: boolean } | null;
  queued: string[];
  map: { rooms: { id: string; rect: number[]; current: boolean }[]; links: string[][] } | null;
};
type Probed = Sample & { screen: Screen; mode: string };
type Case = Omit<Scenario, "samples"> & { samples?: number[]; textures?: string[]; preview?: string };

function probe(cases: Case[]): Probed[][] {
  const dir = mkdtempSync(join(tmpdir(), "anomaly-modals-"));
  try {
    const scenarios = cases.map(({ project, ...rest }) => ({ samples: [], ...rest, project: toRuntimeProject(project) }));
    writeFileSync(join(dir, "in.json"), JSON.stringify({ scenarios }));
    const run = spawnSync(
      process.env.GODOT ?? "godot",
      ["--headless", "--fixed-fps", String(FPS), "--path", GAME_DIR, "--script", "res://tests/modal_probe.gd", "--", join(dir, "in.json"), join(dir, "out.json")],
      { encoding: "utf8", timeout: 60_000 },
    );
    const errors = `${run.stdout}${run.stderr}`.split("\n").filter((line) => /SCRIPT ERROR|^ERROR|WARNING: \[(modal|events)\]/.test(line));
    if (run.status !== 0 || errors.length) throw new Error(`modal probe failed (${run.status}):\n${errors.join("\n")}`);
    const { results } = JSON.parse(readFileSync(join(dir, "out.json"), "utf8")) as { results: { error: string; samples: Probed[] }[] };
    return results.map((r, i) => {
      if (r.error) throw new Error(`case ${i}: ${r.error}`);
      return r.samples;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const press = (action: Input, from: number, to = from + 2) => ({ action, from, to });
const ok = (result: ReturnType<typeof applyOperation>) => {
  if (!result.ok) throw new Error(result.error.message);
  return result.project;
};
const button = (label: string, ...effects: object[]) => ({ label, do: effects });
/** `base` with world fields merged in. */
const withWorld = (base: ProjectSpec, world: Record<string, unknown>) => ProjectSpec.parse({ ...base, world: { ...base.world, ...world } });
const IMAGE = "0123456789abcdef.png";

const patrol = { id: "walker", at: [700, ARENA_FLOOR] as [number, number], initial: "walk", states: { walk: { action: { type: "patrol", speed: 120, distance: 400 } } } };

const cases = {
  // Two modals queued by a timer; a timer started with them waits until both are closed.
  pause: {
    project: withWorld(arena([patrol]), {
      modals: [
        { id: "first", title: "First", body: "Choose.", buttons: [button("Left", { type: "setFlag", flag: "left" }), button("Right", { type: "setFlag", flag: "right" })] },
        { id: "second", title: "Second", image: IMAGE },
      ],
      handlers: [
        { on: { type: "gameStarted" }, do: [{ type: "startTimer", timer: "a", seconds: 0.3 }] },
        { on: { type: "timer", timer: "a" }, do: [{ type: "showModal", modal: "first" }, { type: "showModal", modal: "second" }, { type: "startTimer", timer: "b", seconds: 0.2 }] },
        { on: { type: "timer", timer: "b" }, do: [{ type: "setFlag", flag: "b_done" }] },
      ],
    }),
    textures: [IMAGE],
    frames: 160,
    samples: [30, 60, 80, 95, 116, 160],
    input: [press("move_left", 2, 160), press("move_right", 70), press("jump", 90), press("jump", 110, 120)],
  },
  // A title screen (gameStarted), credits (a title button) and an ending (endGame) are all just modals.
  screens: {
    project: withWorld(arena([]), {
      modals: [
        { id: "title", title: "A Game", buttons: [button("Play", { type: "setFlag", flag: "playing" }, { type: "startTimer", timer: "end", seconds: 0.2 }), button("Credits", { type: "showModal", modal: "credits" })] },
        { id: "credits", title: "Made by", buttons: [button("Back", { type: "showModal", modal: "title" })] },
        { id: "ending", title: "The End" },
      ],
      handlers: [
        { on: { type: "gameStarted" }, do: [{ type: "showModal", modal: "title" }] },
        { on: { type: "timer", timer: "end" }, do: [{ type: "endGame", modal: "ending" }] },
      ],
    }),
    frames: 90,
    samples: [5, 25, 35, 50, 70, 85],
    input: [press("move_right", 10), press("jump", 20), press("jump", 30), press("jump", 40), press("jump", 80)],
  },
  // endGame without a modal starts over at once.
  restart: {
    project: withWorld(arena([]), {
      handlers: [
        { on: { type: "gameStarted" }, do: [{ type: "startTimer", timer: "end", seconds: 0.5 }, { type: "giveItem", item: "coin" }] },
        { on: { type: "timer", timer: "end" }, do: [{ type: "endGame" }] },
      ],
      items: [{ id: "coin", name: "Coin" }],
    }),
    frames: 40,
    samples: [29, 32],
    input: [press("move_right", 1, 40)],
  },
  mapOff: { project: fixtureProject(), world: { room: "entrance", x: 900, y: 384, abilities: [] }, frames: 20, samples: [15], input: [press("map", 5)] },
  map: {
    project: withWorld(ok(applyOperation(fixtureProject(), "setMap", { enabled: true })), {
      handlers: [{ on: { type: "roomEntered", room: "hall" }, do: [{ type: "revealMap", rooms: ["sanctum"] }, { type: "saveRun" }] }],
    }),
    world: { room: "entrance", x: 900, y: 384, abilities: [] },
    frames: 90,
    samples: [45, 55, 75],
    input: [press("move_right", 1, 20), press("map", 40), press("map", 60)],
  },
  // Preview in edit mode: the modal shows over the frozen game; its button only closes it.
  preview: { project: withWorld(arena([]), { modals: [{ id: "note", title: "Note", buttons: [button("Ok", { type: "setFlag", flag: "x" })] }] }), preview: "note", frames: 20, samples: [3, 15], input: [press("jump", 8)] },
} satisfies Record<string, Case>;

// Continue the run the map case saved: its revealed room comes back.
const resumed: Case = { ...cases.map, world: { room: "entrance", x: 96, y: 384, abilities: [], continue: true }, frames: 20, samples: [15], input: [press("map", 5)] };
// revealMap with no rooms reveals them all.
const revealAll: Case = { ...cases.map, project: withWorld(cases.map.project, { handlers: [{ on: { type: "gameStarted" }, do: [{ type: "revealMap" }] }] }), frames: 20, samples: [15], input: [press("map", 5)] };

let r: Record<keyof typeof cases | "resumed" | "revealAll", Probed[]>;
beforeAll(() => {
  const names = [...(Object.keys(cases) as (keyof typeof cases)[]), "resumed", "revealAll"] as const;
  const runs = probe([...Object.values(cases), resumed, revealAll]);
  r = Object.fromEntries(names.map((n, i) => [n, runs[i]!])) as typeof r;
}, 120_000);

const player = (s: Probed | undefined) => entity(s, "player");
const frame = (samples: Probed[], f: number) => samples.find((s) => s.frame === f)!;

describe("modals", () => {
  it("pause the game while open: nothing moves and timers wait, until the last one closes and the keys are let go", () => {
    const s = r.pause;
    const [a, b, chose, next, held, after] = [30, 60, 80, 95, 116, 160].map((f) => frame(s, f));
    expect(a!.modal).toBe("first");
    expect(a!.screen.modal).toMatchObject({ title: "First", body: "Choose.", buttons: ["Left", "Right"], selected: 0, image: false });
    expect(a!.screen.queued).toEqual(["second"]);
    for (const later of [b, chose, next, held]) {
      expect(player(later)).toEqual(player(a));
      expect(entity(later, "walker_1")).toEqual(entity(a, "walker_1"));
    }
    expect(chose!.screen.modal!.selected).toBe(1);
    expect(next!.modal).toBe("second");
    expect(next!.flags).toEqual(["right"]);
    expect(next!.screen.modal).toMatchObject({ buttons: ["Continue"], image: true });
    expect(held!.modal).toBe(null);
    expect(held!.flags).toEqual(["right"]); // timer b has not run yet
    expect(after!.flags.sort()).toEqual(["b_done", "right"]);
    expect(player(after).x).toBeLessThan(player(a).x); // still walking left
    expect(entity(after, "walker_1").x).not.toBe(entity(a, "walker_1").x);
  });

  it("make screens from data: a title at the start, credits from its button, an ending that starts a fresh game", () => {
    const [title, credits, back, playing, ending, again] = [5, 25, 35, 50, 70, 85].map((f) => frame(r.screens, f));
    expect(title!.modal).toBe("title");
    expect(credits!.modal).toBe("credits");
    expect(back!.modal).toBe("title");
    expect(back!.screen.modal!.selected).toBe(0);
    expect(playing!).toMatchObject({ modal: null, flags: ["playing"] });
    expect(ending!).toMatchObject({ modal: "ending", flags: ["playing"] });
    expect(again!).toMatchObject({ modal: "title", flags: [] }); // gameStarted ran again
  });

  it("endGame without a modal starts over at once", () => {
    const [before, after] = r.restart;
    expect(player(before).x).toBeGreaterThan(200);
    expect(player(after).x).toBeLessThan(200);
    expect(after!.items).toEqual({ coin: 1 });
  });

  it("preview in edit mode, where a button only closes it", () => {
    const [shown, closed] = r.preview;
    expect(shown).toMatchObject({ mode: "edit", modal: "note" });
    expect(closed).toMatchObject({ mode: "edit", modal: null, flags: [] });
  });
});

describe("the map", () => {
  it("is off by default", () => {
    expect(r.mapOff[0]).toMatchObject({ mapOpen: false, screen: { map: null } });
  });

  it("shows visited and revealed rooms with the current one highlighted, pausing the game", () => {
    const [open, still, closed] = r.map;
    expect(open!.room).toBe("hall");
    expect(open!.mapOpen).toBe(true);
    expect(open!.screen.map).toEqual({
      rooms: [
        { id: "entrance", rect: [0, 0, 30, 14], current: false },
        { id: "hall", rect: [30, 0, 40, 14], current: true },
        { id: "sanctum", rect: expect.any(Array), current: false },
      ],
      links: [["entrance", "hall"]],
    });
    expect(player(still)).toEqual(player(open));
    expect(closed!.mapOpen).toBe(false);
  });

  it("remembers revealed rooms in the saved run, and revealMap with no rooms reveals all", () => {
    expect(r.resumed[0]!.screen.map!.rooms.map((room) => room.id)).toEqual(["entrance", "hall", "sanctum"]);
    expect(r.revealAll[0]!.screen.map!.rooms).toHaveLength(fixtureProject().world.rooms.length);
  });
});
