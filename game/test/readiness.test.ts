import { beforeAll, describe, expect, it } from "vitest";
import { ARENA_FLOOR, applyBatch, createDefaultProject, lintProject, type ProjectSpec } from "@anomaly/core";
import { callTools, FakeModel, runAgentTurn, say, toolCall, type AgentEvent } from "@anomaly/agent";
import { entity, range, simulate, type Input, type Sample } from "./simulate.ts";

// Readiness: the build assistant can build game logic through its tools alone.
// A scripted model (standing in for the real one) makes a lock-and-key in the
// playtest room with the same tool calls a model would send; the result is
// then played in the real runtime.

const floor = ARENA_FLOOR;
const flag = (name: string, is = true) => ({ type: "flag", flag: name, is });
const calls = [
  toolCall("removeRoomSpawn", { roomId: "arena", spawnId: "crawler_1" }),
  toolCall("removeRoomSpawn", { roomId: "arena", spawnId: "charger_1" }),
  toolCall("createItem", { name: "Key" }),
  toolCall("addProp", { roomId: "arena", id: "key", x: 300, y: floor - 28, width: 24, height: 24, color: "#e8c547", visible: flag("got_key", false) }),
  toolCall("addHandler", { roomId: "arena", propId: "key", handler: { on: { type: "touch" }, do: [{ type: "giveItem", item: "key" }, { type: "setFlag", flag: "got_key" }] } }),
  toolCall("addProp", { roomId: "arena", id: "door", x: 1000, y: 0, width: 32, height: floor, solid: flag("door_open", false), visible: flag("door_open", false) }),
  toolCall("addProp", { roomId: "arena", id: "lock", x: 940, y: floor - 64, width: 32, height: 64, prompt: "Unlock" }),
  toolCall("addHandler", {
    roomId: "arena",
    propId: "lock",
    handler: { on: { type: "interact" }, when: [{ type: "item", item: "key" }], do: [{ type: "takeItem", item: "key" }, { type: "setFlag", flag: "door_open" }] },
  }),
];

let built: ProjectSpec;
let events: AgentEvent[];
let samples: Sample[];
beforeAll(async () => {
  events = [];
  let base = createDefaultProject();
  const result = await runAgentTurn({
    model: new FakeModel([callTools(...calls), say("Added a key by the start and a locked door before the far wall; pick up the key, then press Up at the lock.")]),
    project: base,
    history: [],
    userMessage: "Put a key near the start that unlocks a door at the far end of the room.",
    commit: async (operations) => {
      const applied = applyBatch(base, operations);
      if (!applied.ok) return applied;
      base = applied.project;
      return { ok: true, project: base, canUndo: true };
    },
    onEvent: (e) => events.push(e),
  });
  expect(result.outcome).toBe("committed");
  built = base;
  const hold = (action: Input, from: number, to: number) => ({ action, from, to });
  [samples] = simulate([{ project: built, frames: 300, samples: range(0, 300), input: [hold("move_right", 2, 150), hold("interact", 160, 162), hold("move_right", 175, 300)] }]) as [Sample[]];
}, 180_000);

describe("readiness: the build assistant builds a lock-and-key", () => {
  it("through its tools alone, every call accepted, leaving a project with no new warnings", () => {
    const results = events.filter((e) => e.type === "tool_result");
    expect(results).toHaveLength(calls.length);
    expect(results.every((e) => !(e as { isError?: boolean }).isError)).toBe(true);
    // Only the enemies it took out of the room (to keep this about the lock) go unplaced.
    expect(lintProject(built).map((w) => w.code)).toEqual(["unplaced_character", "unplaced_character"]);
  });

  it("that plays: the door holds without the key and opens with it", () => {
    const blocked = samples.find((s) => s.frame === 150)!;
    expect(blocked.items).toEqual({ key: 1 });
    expect(entity(blocked, "player").x).toBeLessThan(1000);
    const last = samples.at(-1)!;
    expect(last.flags.sort()).toEqual(["door_open", "got_key"]);
    expect(entity(last, "player").x).toBeGreaterThan(1100);
  });
});
