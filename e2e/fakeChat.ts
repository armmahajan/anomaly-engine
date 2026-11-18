import { callTools, FakeModel, runAgentTurn, say, toolCall, type TurnRunner } from "@anomaly/agent";

const page = (id: string, kind: string, title: string, extra: Record<string, unknown> = {}) =>
  toolCall("createWikiPage", { page: { id, kind, title, ...extra } });

const region = (id: string, name: string, extra: Record<string, unknown> = {}) => toolCall("createRegion", { region: { id, name, ...extra } });
const connection = (id: string, from: string, to: string, extra: Record<string, unknown> = {}) =>
  toolCall("createConnection", { connection: { id, from, to, ...extra } });

/** gate <-> city <-dash-> tower -lamp_key-> deep: three spheres, critical path Dash -> Lamp Key. */
const fakeStructure: TurnRunner = (request) =>
  runAgentTurn({
    ...request,
    model: new FakeModel([
      callTools(
        region("gate", "Sunken Gate", { rooms: 4, enemies: ["crawler"] }),
        region("city", "Drowned City", { rooms: 12, enemies: ["crawler", "charger"], boss: "charger" }),
        region("tower", "Bell Tower"),
        region("deep", "The Deep", { rooms: 3 }),
        toolCall("createAbility", { ability: { id: "dash", name: "Dash", mechanic: "dash", obtainedIn: { regionId: "city", source: "boss" } } }),
        toolCall("createAbility", { ability: { id: "lamp_key", name: "Lamp Key", mechanic: "key", obtainedIn: { regionId: "tower", source: "shrine" } } }),
        connection("gate_city", "gate", "city"),
        connection("city_tower", "city", "tower", { requires: ["dash"] }),
        connection("tower_deep", "tower", "deep", { requires: ["lamp_key"], oneWay: true }),
        toolCall("setProgressionEnds", { start: "gate", ending: "deep" }),
      ),
      say("Drafted four regions, the Dash and the Lamp Key. Should the Lamp Key come from a boss instead?"),
    ]),
  });

/** "cast": the player, two enemies (one a guardian) and a story-only sage, marked with in_game. */
const fakeCast: TurnRunner = (request) =>
  runAgentTurn({
    ...request,
    model: new FakeModel([
      callTools(
        page("lamplighter", "character", "The Lamplighter", { summary: "The last keeper of the flame.", fields: { role: "protagonist", in_game: "player", appearance: "a small cloaked figure with a lantern" } }),
        page("moth_knight", "character", "Moth Knight", { summary: "Guardian of the bell.", fields: { role: "guardian", in_game: "enemy (boss)", appearance: "dusty wings, a pale lance" } }),
        page("lamp_grub", "character", "Lamp Grub", { summary: "Vermin that eat light.", fields: { role: "vermin", in_game: "enemy", appearance: "a glowing larva" } }),
        page("old_sage", "character", "The Old Sage", { summary: "Remembers the flood.", fields: { role: "mentor", in_game: "none" } }),
      ),
      say("Drafted the Lamplighter, two enemies and the Old Sage."),
    ]),
  });

/** "weapon": a weapon page, marked with in_game. */
const fakeWeapon: TurnRunner = (request) =>
  runAgentTurn({
    ...request,
    model: new FakeModel([
      callTools(
        page("ember_hook", "weapon", "Ember Hook", {
          summary: "A lamplighter's hook, still warm.",
          fields: { in_game: "weapon", appearance: "a brass hook glowing at the tip", attacks: "a wide sweep; an upward jab" },
        }),
      ),
      say("Drafted the Ember Hook."),
    ]),
  });

/** Scripted director: drafts the progression when asked about structure, the cast when asked for it, a weapon when asked for one, otherwise a small wiki skeleton. */
const fakeDirector: TurnRunner = (request) =>
  /structure|progression/i.test(request.userMessage)
    ? fakeStructure(request)
    : /\bcast\b/i.test(request.userMessage)
      ? fakeCast(request)
      : /\bweapon\b/i.test(request.userMessage)
        ? fakeWeapon(request)
        : fakeWiki(request);

const fakeWiki: TurnRunner = (request) =>
  runAgentTurn({
    ...request,
    model: new FakeModel([
      callTools(
        page("overview", "overview", "Drowned Lamp", {
          summary: "A lonely, hopeful descent through a flooded kingdom.",
          fields: { tone: "lonely, hopeful" },
          body: "You are [[hero|the last lamplighter]], carrying light down into [[drowned_city]].",
        }),
        page("hero", "character", "The Lamplighter", { characterId: "player", fields: { role: "player character" }, body: "Keeper of [[the_tide]]'s last flame." }),
        page("drowned_city", "place", "The Drowned City", { summary: "Streets under black water.", body: "Home of the [[charger_lore|Chargers]]." }),
        page("the_tide", "deity", "The Tide", { summary: "A god who forgets." }),
      ),
      say("Drafted an overview, the Lamplighter, the Drowned City and a deity, the Tide. Who is the antagonist?"),
    ]),
  });

/** Scripted build assistant: "world: <theme>" queues a world; "crawler speed N" sets the Crawler's patrol speed. */
/** "build from the design": two rooms of the director's first regions, joined, with a title, a start and an ending. */
const fakeBuildFromDesign: TurnRunner = (request) =>
  runAgentTurn({
    ...request,
    model: new FakeModel([
      callTools(toolCall("getProgression", {})),
      callTools(
        toolCall("createWorldRoom", { name: "Gate Hall", id: "gate_hall", cols: 30, rows: 14 }),
        toolCall("createWorldRoom", { name: "City Steps", id: "city_steps", cols: 30, rows: 14 }),
        toolCall("updateWorldRoom", { roomId: "gate_hall", changes: { regionId: "gate" } }),
        toolCall("updateWorldRoom", { roomId: "city_steps", changes: { regionId: "city" } }),
        toolCall("setDoor", { roomId: "gate_hall", door: { id: "east", side: "right", offset: 10, size: 3 } }),
        toolCall("setDoor", { roomId: "city_steps", door: { id: "west", side: "left", offset: 10, size: 3 } }),
        toolCall("connectDoors", { from: { roomId: "gate_hall", doorId: "east" }, to: { roomId: "city_steps", doorId: "west" } }),
        toolCall("setWorldStart", { roomId: "gate_hall", x: 96, y: 416 }),
        toolCall("setPlaytest", { roomId: "gate_hall", x: 96, y: 416 }),
        toolCall("createModal", { title: "Drowned Lamp", body: "Find the lamp.", id: "title" }),
        toolCall("createModal", { title: "The End", body: "The lamp is lit.", id: "ending" }),
        toolCall("addHandler", { handler: { on: { type: "gameStarted" }, do: [{ type: "showModal", modal: "title" }] } }),
        toolCall("addProp", { roomId: "city_steps", id: "lamp", name: "Lamp", x: 800, y: 352, width: 32, height: 64 }),
        toolCall("addHandler", { roomId: "city_steps", propId: "lamp", handler: { on: { type: "touch" }, do: [{ type: "endGame", modal: "ending" }] } }),
      ),
      say("Built the Gate Hall and the City Steps from the progression, joined them, and added a title and an ending at the lamp."),
    ]),
  });

/** Scripted Architect: (re)seeds the plan from the progression when asked to plan; "build" also queues a run. */
const fakeArchitect: TurnRunner = (request) => {
  const build = /\bbuild\b/i.test(request.userMessage) && !/don't queue a build run/i.test(request.userMessage);
  const seed = request.project.architect.rooms.length === 0;
  return runAgentTurn({
    ...request,
    model: new FakeModel([
      callTools(...(seed ? [toolCall("seedArchitectPlan", {})] : []), toolCall("checkPlan", {}), ...(build ? [toolCall("runArchitect", {})] : [])),
      say(seed ? "Planned the world from the progression." : "The plan looks complete."),
    ]),
  });
};

/** The live cast's request: a chasing behavior and a size for each new enemy. */
const fakeBehaviors: TurnRunner = (request) => {
  const list = /their behavior: (.+?)\. They were/.exec(request.userMessage)?.[1] ?? "";
  const ids = list.split(", ").map((s) => s.split(" ")[0]!);
  const behavior = { initial: "prowl", states: { prowl: { action: { type: "patrol", speed: 150, distance: 260, turnAtLedge: true, turnAtWall: true }, transitions: [] } }, interrupts: [] };
  return runAgentTurn({
    ...request,
    model: new FakeModel([callTools(...ids.flatMap((characterId) => [toolCall("setBehavior", { characterId, behavior }), toolCall("updateCharacter", { characterId, changes: { size: { width: 40, height: 36 } } })])), say("Wrote their behaviors.")]),
  });
};

/** The live cast's request for new weapons: a sweep and an upward jab for each. */
const fakeAttacks: TurnRunner = (request) => {
  const list = /their attacks: (.+?)\. They were/.exec(request.userMessage)?.[1] ?? "";
  const ids = list.split(", ").map((s) => s.split(" ")[0]!);
  const sweep = { id: "sweep", name: "Sweep", shape: { type: "arc", radius: 80, from: -70, to: 70 }, damage: 1 };
  const jab = { id: "jab", name: "Upward jab", trigger: { aim: "up" }, shape: { type: "thrust", length: 110 }, damage: 1 };
  return runAgentTurn({
    ...request,
    model: new FakeModel([callTools(...ids.flatMap((weaponId) => [toolCall("setWeaponAttack", { weaponId, attack: sweep }), toolCall("setWeaponAttack", { weaponId, attack: jab })])), say("Wrote their attacks.")]),
  });
};

const fakeBuilder: TurnRunner = (request) => {
  if (/^build from the design/i.test(request.userMessage.trim())) return fakeBuildFromDesign(request);
  if (/^give these new weapons their attacks/i.test(request.userMessage.trim())) return fakeAttacks(request);
  if (/^give these new enemy characters their behavior/i.test(request.userMessage.trim())) return fakeBehaviors(request);
  // The Architect's cast stage: nothing to create in the scripted games.
  if (/^create these enemy characters/i.test(request.userMessage.trim())) return runAgentTurn({ ...request, model: new FakeModel([say("Nothing to create.")]) });
  const world = /^world: (.+)$/i.exec(request.userMessage.trim());
  if (world) {
    return runAgentTurn({
      ...request,
      model: new FakeModel([callTools(toolCall("generateWorld", { theme: world[1] })), say(`Painting ${world[1]}: it will show in Worlds in about a minute.`)]),
    });
  }
  const speed = Number(/\d+/.exec(request.userMessage)?.[0] ?? 150);
  return runAgentTurn({
    ...request,
    model: new FakeModel([
      callTools(toolCall("updateBehavior", { characterId: "crawler", stateId: "patrol", action: { speed } })),
      say(`Set the Crawler's patrol speed to ${speed}.`),
    ]),
  });
};

/** Scripted chat backend for e2e, one script per agent. */
export const fakeChatRunner: TurnRunner = (request) =>
  (request.agent?.id === "narrative" ? fakeDirector : request.agent?.id === "architect" ? fakeArchitect : fakeBuilder)(request);
