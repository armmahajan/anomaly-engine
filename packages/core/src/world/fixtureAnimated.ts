import type { ProjectSpec } from "../schema.ts";
import type { Clip } from "../art/clip.ts";
import { createDefaultProject, ARENA_FLOOR } from "../defaultProject.ts";
import { exampleRig } from "../art/example.ts";
import { applyOperation } from "../operations.ts";

/**
 * The animation target's shared fixture (core art/animation.ts): the starter arena, built only
 * through operations, with
 *   - objects (subject object, rigged and animated): `lever`, `trap`, `shockwave`, `bolt`;
 *   - a trap prop (object art, idle loop): touching it plays `snap`, whose `strike` marker hurts;
 *   - a lever prop: interacting plays `pull` (held), whose `click` marker sets flag `lever_pulled`;
 *   - a door prop, solid and shown until `lever_pulled`;
 *   - the crawler shooting from above its head: appear windup with the `bolt` object (charge, fly,
 *     burst clips);
 *   - the charger drawn with `charger_look`, whose `attack` clip has an `impact` marker; its spawn
 *     answers it with a shockwave effect and a shake.
 * Rigs are the example rig (bones root, body, head, horn, leg_*); clips are small motions. Tests of
 * every part of the target use it; the studio's e2e tests load it too.
 */

const clip = (duration: number, loop: boolean, markers: { t: number; name: string }[] = [], bone = "body"): Clip => ({
  duration,
  loop,
  tracks: [],
  motions: loop ? [{ type: "bob", bone, amount: 3, cycles: 1, phase: 0 }] : [{ type: "squash", bone, amount: 0.3, at: 0.5, width: 0.3 }],
  visibility: [],
  markers,
});

export const ANIMATED_OBJECTS = {
  lever: { brief: "a rusted floor lever with a red knob", clips: { idle: clip(1.2, true), pull: clip(0.6, false, [{ t: 0.7, name: "click" }]) } },
  trap: { brief: "a spring-loaded jaw trap set into the floor", clips: { idle: clip(1, true), snap: clip(0.5, false, [{ t: 0.4, name: "strike" }]) } },
  shockwave: { brief: "a crackling ring of force spreading along the ground", clips: { idle: clip(0.5, false), burst: clip(0.5, false) } },
  bolt: { brief: "a glowing plasma bolt", clips: { idle: clip(0.4, true), charge: clip(0.4, true), fly: clip(0.3, true), burst: clip(0.3, false) } },
} as const;

export function fixtureAnimatedProject(): ProjectSpec {
  let p = createDefaultProject();
  const op = (name: string, input: unknown) => {
    const r = applyOperation(p, name, input);
    if (!r.ok) throw new Error(`fixtureAnimatedProject: ${name}: ${r.error.message} ${JSON.stringify(r.error.issues)}`);
    p = r.project;
  };
  const rig = exampleRig();

  for (const [id, o] of Object.entries(ANIMATED_OBJECTS)) {
    op("createObject", { id, name: id[0]!.toUpperCase() + id.slice(1), brief: o.brief });
    op("setRig", { assetId: id, rig });
    for (const [clipId, c] of Object.entries(o.clips)) op("setClip", { assetId: id, clipId, clip: c });
  }

  // The charger, drawn: its attack clip lands an `impact`.
  op("createAsset", { asset: { id: "charger_look", name: "Charger look", kind: "character", brief: "a horned beetle" }, assignTo: "charger" });
  op("setRig", { assetId: "charger_look", rig });
  op("setClip", { assetId: "charger_look", clipId: "idle", clip: clip(1, true) });
  op("setClip", { assetId: "charger_look", clipId: "attack", clip: clip(0.6, false, [{ t: 0.5, name: "impact" }]) });
  op("addHandler", {
    roomId: "arena",
    spawnId: "charger_1",
    handler: { on: { type: "marker", name: "impact" }, do: [{ type: "spawnEffect", object: "shockwave", clip: "burst", at: { kind: "self" }, offset: [0, 20] }, { type: "shake", strength: 8, seconds: 0.3 }] },
  });

  // The trap, the lever and the door it opens.
  const floor = ARENA_FLOOR;
  op("addProp", {
    roomId: "arena",
    id: "trap",
    name: "Trap",
    x: 320,
    y: floor - 24,
    width: 48,
    height: 24,
    art: { object: "trap", idle: "idle" },
    handlers: [
      { on: { type: "touch" }, do: [{ type: "playAnimation", target: { kind: "self" }, clip: "snap" }] },
      { on: { type: "marker", name: "strike" }, do: [{ type: "damage", amount: 1 }] },
    ],
  });
  op("addProp", {
    roomId: "arena",
    id: "lever",
    name: "Lever",
    x: 440,
    y: floor - 48,
    width: 32,
    height: 48,
    art: { object: "lever", idle: "idle" },
    prompt: "Pull",
    handlers: [
      { on: { type: "interact" }, when: [{ type: "flag", flag: "lever_pulled", is: false }], do: [{ type: "playAnimation", target: { kind: "self" }, clip: "pull", then: "hold" }] },
      { on: { type: "marker", name: "click" }, do: [{ type: "setFlag", flag: "lever_pulled" }] },
    ],
  });
  op("addProp", {
    roomId: "arena",
    id: "door",
    name: "Door",
    x: 520,
    y: floor - 128,
    width: 32,
    height: 128,
    color: "#6b5a4a",
    solid: { type: "flag", flag: "lever_pulled", is: false },
    visible: { type: "flag", flag: "lever_pulled", is: false },
  });

  // The crawler fires a bolt that forms above its head through the windup.
  op("setBehavior", {
    characterId: "crawler",
    behavior: {
      initial: "rest",
      states: {
        rest: { action: { type: "wait" }, transitions: [{ when: { type: "after", seconds: 1 }, to: "fire" }] },
        fire: {
          action: {
            type: "shoot",
            windup: 0.8,
            count: 1,
            speed: 420,
            aim: "player",
            lifetime: 3,
            damage: 1,
            look: { origin: [0, -60], appear: "windup", art: { object: "bolt", charge: "charge", fly: "fly", burst: "burst" } },
          },
          transitions: [{ when: { type: "actionDone" }, to: "rest" }],
        },
      },
      interrupts: [],
    },
  });
  return p;
}
