import { expect, type Page } from "@playwright/test";
import { ANIMATED_OBJECTS, fixtureAnimatedProject, type CharacterAsset } from "@anomaly/core";

/**
 * The animation target's shared fixture (core world/fixtureAnimated.ts) applied to the starter project
 * in the studio, as one batch of the same operations: the lever, trap, shockwave and bolt objects
 * (rigged, with clips and markers), the charger drawn with charger_look (its attack clip lands an
 * `impact`), the trap, lever and door props, the charger spawn's impact handler and the crawler's
 * windup bolt.
 */
export async function loadAnimatedFixture(page: Page) {
  const fixture = fixtureAnimatedProject();
  const asset = (id: string) => fixture.art.assets.find((a) => a.id === id) as CharacterAsset;
  const arena = fixture.world.rooms.find((r) => r.id === "arena")!;
  const drawn = (id: string) => [
    { name: "setRig", input: { assetId: id, rig: asset(id).rig } },
    ...Object.entries(asset(id).clips).map(([clipId, clip]) => ({ name: "setClip", input: { assetId: id, clipId, clip } })),
  ];
  const ops = [
    ...Object.keys(ANIMATED_OBJECTS).flatMap((id) => [{ name: "createObject", input: { id, name: asset(id).name, brief: asset(id).brief } }, ...drawn(id)]),
    { name: "createAsset", input: { asset: { id: "charger_look", name: "Charger look", kind: "character", brief: asset("charger_look").brief }, assignTo: "charger" } },
    ...drawn("charger_look"),
    { name: "setHandlers", input: { roomId: "arena", spawnId: "charger_1", handlers: arena.spawns.find((s) => s.id === "charger_1")!.handlers } },
    ...arena.props.filter((p) => ["trap", "lever", "door"].includes(p.id)).map((p) => ({ name: "addProp", input: { roomId: "arena", ...p } })),
    { name: "setBehavior", input: { characterId: "crawler", behavior: (fixture.characters.find((c) => c.id === "crawler") as { behavior: unknown }).behavior } },
  ];
  const result = await page.evaluate((calls) => window.studio!.applyBatch(calls), ops);
  expect(result.ok, JSON.stringify(result)).toBe(true);
}
