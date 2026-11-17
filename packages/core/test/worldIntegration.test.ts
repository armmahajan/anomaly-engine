import { describe, expect, it } from "vitest";
import { FIXTURE_END_ROOM, FIXTURE_START_ROOM, fixtureProject, movementParams, worldTraversal, type PlayerCharacter } from "../src/index.ts";

// The fixture world is played start to end in the runtime (game/test/world.test.ts);
// the traversal checker must agree it can be finished.
describe("the traversal checker on the world runtime's fixture", () => {
  it("finds the fixture world finishable from its start, through every room", () => {
    const project = fixtureProject();
    const player = project.characters.find((c) => c.kind === "player") as PlayerCharacter;
    const params = movementParams(player, project.world.gravity);
    const { rooms } = worldTraversal(project.world, params, []);
    expect(project.world.start?.room).toBe(FIXTURE_START_ROOM);
    expect(rooms.has(FIXTURE_END_ROOM)).toBe(true);
    expect([...rooms].sort()).toEqual(project.world.rooms.map((r) => r.id).sort());
  }, 60_000);
});
