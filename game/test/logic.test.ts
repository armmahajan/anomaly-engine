import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { fixtureProject, gridSize, LogicRun, logicGame, ProjectSpec, TILE, toRuntimeProject, type RunSnapshot } from "@anomaly/core";
import { FPS } from "./simulate.ts";

// The mirror test: the checker's game-logic engine (core world/logic/interpret.ts)
// against the real runtime (events.gd, world_runtime.gd, props.gd, modal.gd).
// One scripted sequence of events drives both (the runtime through
// game/tests/logic_probe.gd, step by step in one frame); after every step the
// run's room, visited rooms, flags, items, abilities, checkpoint, open modals
// and saved run must be identical.

const GAME_DIR = fileURLToPath(new URL("..", import.meta.url));

type Step =
  | { do: "fire"; event: { type: string } }
  | { do: "touch" | "interact" | "hit"; prop: string }
  | { do: "kill"; spawn: string }
  | { do: "die" }
  | { do: "timer"; timer: string }
  | { do: "press"; button: number }
  | { do: "door"; door: string }
  | { do: "continue" };
interface Observed {
  room: string;
  visited: string[];
  flags: string[];
  items: Record<string, number>;
  abilities: string[];
  checkpoint: { room: string; x: number; y: number } | null;
  modals: string[];
  saved: (RunSnapshot & { modals?: unknown }) | null;
}

const flag = (name: string, is = true) => ({ type: "flag", flag: name, is });
const item = (id: string, atLeast = 1) => ({ type: "item", item: id, atLeast });
const on = (type: string, extra: object = {}) => ({ type, ...extra });
const prop = (id: string, x: number, handlers: object[], rest: object = {}) => ({ id, x, y: 15 * TILE, width: TILE, height: 2 * TILE, handlers, ...rest });

/** The fixture world with game logic using every condition, every effect that changes the run, and handlers on the world, rooms, props and spawns. */
function project(): ProjectSpec {
  const base = fixtureProject();
  const rooms = base.world.rooms.map((room) => {
    if (room.id === "cistern") {
      return {
        ...room,
        spawns: [
          { ...room.spawns[0]!, handlers: [{ on: on("enemyKilled"), do: [{ type: "giveItem", item: "trophy" }, { type: "grantAbility", ability: "dash" }] }] },
          { id: "ghost_1", characterId: "crawler", x: 25 * TILE, y: 17 * TILE, when: flag("haunted") },
        ],
        handlers: [
          { on: on("roomEntered"), do: [{ type: "setFlag", flag: "cistern_entered" }] },
          { on: on("roomCleared"), do: [{ type: "setFlag", flag: "cleared" }] },
          { on: on("roomSettled"), do: [{ type: "giveItem", item: "token" }] },
        ],
        props: [
          prop("gem", 10 * TILE, [{ on: on("touch"), when: [flag("gem_taken", false)], do: [{ type: "giveItem", item: "gem" }, { type: "setFlag", flag: "gem_taken" }] }], { width: 24, height: 24, y: 17 * TILE - 40, visible: flag("gem_taken", false) }),
          prop("post", 12 * TILE, [
            { on: on("interact"), when: [item("gem")], do: [{ type: "takeItem", item: "gem" }, { type: "setFlag", flag: "opened" }] },
            { on: on("interact"), when: [{ type: "not", of: item("gem") }], do: [{ type: "showModal", modal: "need" }] },
          ]),
          prop("crate", 15 * TILE, [{ on: on("hit"), do: [{ type: "giveItem", item: "chip" }] }, { on: on("destroyed"), do: [{ type: "setFlag", flag: "crate_broken" }] }], { health: 2, visible: flag("crate_broken", false) }),
          prop("lamp", 18 * TILE, [{ on: on("roomEntered"), do: [{ type: "setFlag", flag: "lamp_saw" }] }], { visible: flag("lamp_on") }),
          prop("lamp2", 19 * TILE, [{ on: on("roomEntered"), when: [{ type: "any", of: [flag("cleared"), item("chip", 2)] }], do: [{ type: "setFlag", flag: "lamp2_saw" }] }]),
          prop("stone", 21 * TILE, [{ on: on("interact"), do: [{ type: "setCheckpoint" }, { type: "saveRun" }] }]),
          prop("back", 23 * TILE, [{ on: on("interact"), do: [{ type: "respawn", at: "entry" }] }]),
          prop("home", 25 * TILE, [{ on: on("interact"), do: [{ type: "respawn", at: "start" }] }]),
          prop("marker", 27 * TILE, [{ on: on("interact"), do: [{ type: "setCheckpoint", room: "spikes", x: 100, y: 12 * TILE }] }]),
        ],
      };
    }
    if (room.id === "spikes") {
      return {
        ...room,
        handlers: [
          { on: on("roomEntered"), do: [{ type: "setFlag", flag: "spikes_entered" }] },
          { on: on("enemyKilled"), do: [{ type: "setFlag", flag: "wrong_room" }] },
        ],
      };
    }
    return room;
  });
  return ProjectSpec.parse({
    ...base,
    id: "logic_mirror",
    world: {
      ...base.world,
      rooms,
      rules: { onDeath: "checkpoint", save: "room", hazardDamage: 0 },
      items: ["coin", "gem", "chip", "trophy", "life", "token"].map((id) => ({ id, name: id })),
      modals: [
        { id: "need", title: "Need", buttons: [{ label: "OK", do: [{ type: "setFlag", flag: "told" }] }, { label: "Give", do: [{ type: "giveItem", item: "gem" }, { type: "showModal", modal: "thanks" }] }] },
        { id: "thanks", title: "Thanks" },
        { id: "end", title: "End" },
      ],
      handlers: [
        { on: on("gameStarted"), do: [{ type: "giveItem", item: "coin", count: 3 }, { type: "startTimer", timer: "t1", seconds: 600 }] },
        // Judged when the event happens: both run, though the first sets what the second checks.
        { on: on("gameStarted"), when: [flag("a", false)], do: [{ type: "setFlag", flag: "a" }] },
        { on: on("gameStarted"), when: [flag("a", false)], do: [{ type: "setFlag", flag: "b" }] },
        { on: on("timer", { timer: "t1" }), do: [{ type: "takeItem", item: "coin", count: 3 }, { type: "setFlag", flag: "timed" }, { type: "setFlag", flag: "a", value: false }] },
        { on: on("enemyKilled", { character: "crawler" }), when: [{ type: "all", of: [item("trophy"), { type: "ability", ability: "dash" }] }], do: [{ type: "setFlag", flag: "any_crawler" }] },
        { on: on("hazardTouched"), do: [{ type: "setFlag", flag: "ouch" }, { type: "setCheckpoint" }] },
        { on: on("playerDied"), do: [{ type: "giveItem", item: "life" }] },
        { on: on("roomEntered", { room: "spikes" }), when: [{ type: "visited", room: "cistern" }], do: [{ type: "setFlag", flag: "back_trip" }] },
        { on: on("roomEntered", { room: "hall" }), do: [{ type: "endGame", modal: "end" }] },
      ],
    },
  });
}

const START = { room: "cistern", x: 3 * TILE, y: 17 * TILE, abilities: [] as string[] };
const STEPS: Step[] = [
  { do: "touch", prop: "gem" },
  { do: "touch", prop: "gem" },
  { do: "interact", prop: "post" },
  { do: "interact", prop: "post" },
  { do: "press", button: 1 },
  { do: "press", button: 0 },
  { do: "interact", prop: "post" },
  { do: "interact", prop: "post" },
  { do: "press", button: 0 },
  { do: "hit", prop: "crate" },
  { do: "hit", prop: "crate" },
  { do: "hit", prop: "crate" },
  { do: "interact", prop: "stone" },
  { do: "kill", spawn: "crawler_1" },
  { do: "timer", timer: "t1" },
  { do: "fire", event: { type: "hazardTouched" } },
  { do: "door", door: "east" },
  { do: "die" },
  { do: "kill", spawn: "crawler_1" },
  { do: "interact", prop: "back" },
  { do: "interact", prop: "marker" },
  { do: "die" },
  { do: "door", door: "west" },
  { do: "interact", prop: "home" },
  { do: "continue" },
  { do: "door", door: "east" },
];

function probe(spec: ProjectSpec): Observed[] {
  const dir = mkdtempSync(join(tmpdir(), "anomaly-logic-"));
  try {
    writeFileSync(join(dir, "in.json"), JSON.stringify({ scenarios: [{ project: toRuntimeProject(spec), world: START, settle: 10, steps: STEPS }] }));
    const run = spawnSync(
      process.env.GODOT ?? "godot",
      ["--headless", "--fixed-fps", String(FPS), "--path", GAME_DIR, "--script", "res://tests/logic_probe.gd", "--", join(dir, "in.json"), join(dir, "out.json")],
      { encoding: "utf8", timeout: 60_000 },
    );
    const errors = `${run.stdout}${run.stderr}`.split("\n").filter((line) => /SCRIPT ERROR|^ERROR|WARNING: \[events\]/.test(line));
    if (run.status !== 0 || errors.length) throw new Error(`logic probe failed (${run.status}):\n${errors.join("\n")}`);
    const { results } = JSON.parse(readFileSync(join(dir, "out.json"), "utf8")) as { results: { error: string; states: Observed[] }[] };
    if (results[0]!.error) throw new Error(results[0]!.error);
    return results[0]!.states;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The same steps through the TypeScript engine (positions as the runtime has them: nothing moves between steps). */
function mirror(spec: ProjectSpec): Observed[] {
  const game = logicGame(spec, { room: START.room, at: { x: START.x, y: START.y } });
  const size = spec.characters.find((c) => c.kind === "player")!.size;
  let run = LogicRun.start(game, START.abilities);
  run.feet = { x: START.x, y: START.y };
  run.settle({ x: START.x, y: START.y });
  let saved = run.saved;
  const observe = (): Observed => {
    if (run.saved) saved = run.saved;
    return {
      room: run.room,
      visited: [...run.visited],
      flags: [...run.flags].sort(),
      items: Object.fromEntries(run.items),
      abilities: [...run.abilities],
      checkpoint: run.checkpoint,
      modals: run.modals.map((m) => m.id),
      saved,
    };
  };
  /** world_runtime._go_through with the player at the opening's start (`along` zero). */
  const through = (doorId: string) => {
    const door = game.rooms.get(run.room)!.doors.find((d) => d.id === doorId)!;
    const target = game.rooms.get(door.to!.room)!;
    const arrive = target.doors.find((d) => d.id === door.to!.door)!;
    const { width } = gridSize(target.grid);
    const lo = arrive.offset * TILE;
    const at = { x: arrive.side === "left" ? size.width / 2 + 1 : width - size.width / 2 - 1, y: Math.min(Math.max(lo, lo + size.height), lo + arrive.size * TILE) };
    run.goThrough(target.id, at, arrive.id);
  };
  const out = [observe()];
  for (const step of STEPS) {
    switch (step.do) {
      case "fire":
        run.touchHazard();
        break;
      case "touch":
        run.touch(step.prop);
        break;
      case "interact":
        run.interact(step.prop);
        break;
      case "hit":
        run.hit(step.prop);
        break;
      case "kill":
        run.kill(step.spawn);
        break;
      case "die":
        run.die();
        break;
      case "timer":
        run.timer(step.timer);
        break;
      case "press":
        run.press(step.button);
        break;
      case "door":
        through(step.door);
        break;
      case "continue":
        run = LogicRun.start(game, START.abilities, saved!);
        break;
    }
    out.push(observe());
  }
  return out;
}

describe("the logic engine mirrors the runtime", () => {
  let runtime: Observed[];
  beforeAll(() => {
    runtime = probe(project());
  }, 120_000);

  it("gives identical flags, items, abilities, checkpoint, modals and saves after every step", () => {
    // The runtime saves "no checkpoint" as {}, which loads back as none.
    const strip = (o: Observed) => ({ ...o, saved: o.saved && { ...o.saved, modals: undefined, flags: [...o.saved.flags].sort(), checkpoint: o.saved.checkpoint && Object.keys(o.saved.checkpoint).length ? o.saved.checkpoint : null } });
    const ts = mirror(project());
    expect(runtime).toHaveLength(STEPS.length + 1);
    ts.forEach((state, i) => expect(strip(runtime[i]!), `after step ${i}: ${JSON.stringify(STEPS[i - 1] ?? "start")}`).toEqual(strip(state)));
  });

  it("covers what it claims (the script reaches every handler)", () => {
    const last = runtime.at(-1)!;
    const seen = new Set(runtime.flatMap((s) => s.flags));
    for (const f of ["a", "b", "gem_taken", "opened", "told", "crate_broken", "cistern_entered", "cleared", "timed", "ouch", "spikes_entered", "back_trip"]) expect(seen, f).toContain(f);
    expect(seen).not.toContain("wrong_room");
    // Judged when the first kill happened, before the spawn's own handler gave the trophy and dash; the second kill sets it.
    const kills = STEPS.flatMap((s, i) => (s.do === "kill" ? [i + 1] : []));
    expect(runtime[kills[0]!]).toMatchObject({ abilities: ["dash"], items: { trophy: 1 } });
    expect(runtime[kills[0]!]!.flags).not.toContain("any_crawler");
    expect(runtime[kills[1]!]!.flags).toContain("any_crawler");
    expect(seen).not.toContain("lamp_saw");
    expect(runtime.some((s) => s.checkpoint?.room === "spikes")).toBe(true);
    expect(runtime.some((s) => (s.items.life ?? 0) >= 2)).toBe(true);
    expect(last).toMatchObject({ room: "hall", modals: ["end"] });
  });
});
