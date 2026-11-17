/** Test enemies that exercise every movement and sensing primitive (player moved to x 300). */

export const FLOOR = 672;
/** Top of the starter arena's ledge (x 384-608) and of its breakable block (x 736-928). */
export const LEDGE_TOP = 544;
export const BLOCK_TOP = 416;
const wait = { type: "wait" };
type Step = [Record<string, unknown>, string];

const transitions = (steps: Step[] = []) => steps.map(([when, to]) => ({ when, to }));

function enemy(id: string, initial: string, states: Record<string, [Record<string, unknown>, Step[]?]>, interrupts: Step[] = []) {
  return {
    id,
    kind: "enemy",
    name: id,
    color: "#888888",
    size: { width: 32, height: 32 },
    stats: { knockback: 0, contactDamage: 0 },
    behavior: {
      initial,
      states: Object.fromEntries(
        Object.entries(states).map(([k, [action, go]]) => [k, { action, transitions: transitions(go) }]),
      ),
      interrupts: transitions(interrupts),
    },
  };
}

const sensor = (id: string, condition: Record<string, unknown>) =>
  enemy(id, "idle", { idle: [wait, [[condition, "yes"]]], yes: [wait] });

const cast: [ReturnType<typeof enemy>, [number, number][]][] = [
  [enemy("hopper", "leap", { leap: [{ type: "jump", height: 120, distance: 200, toward: "facing" }, [[{ type: "actionDone" }, "landed"]]], landed: [wait] }), [[1000, FLOOR]]],
  [enemy("coward", "go", { go: [{ type: "retreat", speed: 200 }] }), [[700, FLOOR]]],
  [enemy("chaser", "go", { go: [{ type: "chase", speed: 300, stopDistance: 150 }] }), [[1000, FLOOR]]],
  [
    enemy("homebody", "out", {
      out: [{ type: "chase", speed: 300 }, [[{ type: "after", seconds: 1 }, "back"]]],
      back: [{ type: "returnHome", speed: 300 }, [[{ type: "actionDone" }, "home"]]],
      home: [wait],
    }),
    [[1300, FLOOR]],
  ],
  [
    enemy("guard", "fall", { fall: [wait], landed: [wait, [[{ type: "after", seconds: 0.3 }, "rest"]]], rest: [wait] }, [[{ type: "onGround" }, "landed"]]),
    [[1450, 300]],
  ],
  [enemy("coin", "flip", { flip: [wait, [[{ type: "chance", p: 0.5 }, "heads"], [{ type: "after", seconds: 0 }, "tails"]]], heads: [wait], tails: [wait] }), Array.from({ length: 12 }, () => [1500, FLOOR] as [number, number])],
  [sensor("high", { type: "playerBelow" }), [[830, BLOCK_TOP]]],
  [sensor("level", { type: "playerAbove" }), [[1100, FLOOR]]],
  [sensor("even", { type: "playerLevel" }), [[1100, FLOOR]]],
  [sensor("uneven", { type: "playerLevel" }), [[830, BLOCK_TOP]]],
  [sensor("facer", { type: "playerBehind" }), [[600, FLOOR]]],
  [sensor("front", { type: "playerInFront" }), [[600, FLOOR]]],
  [sensor("seer", { type: "canSeePlayer" }), [[1100, FLOOR]]],
  [sensor("blind", { type: "canSeePlayer" }), [[830, BLOCK_TOP]]],
  [enemy("edge", "walk", { walk: [{ type: "patrol", speed: 100, distance: 1000 }, [[{ type: "atLedge" }, "stop"]]], stop: [wait] }), [[490, LEDGE_TOP]]],
  [enemy("dropper", "fall", { fall: [wait, [[{ type: "onGround" }, "down"]]], down: [wait, [[{ type: "airborne" }, "fall"]]] }), [[1350, 300]]],
];

export const castOperations = () => [
  { name: "setPlaytest", input: { x: 300 } },
  ...cast.flatMap(([character, spots]) => [
    { name: "createCharacter", input: { character } },
    ...spots.map(([x, y], i) => ({ name: "addRoomSpawn", input: { roomId: "arena", characterId: character.id, spawnId: `${character.id}_${i + 1}`, x, y } })),
  ]),
];
