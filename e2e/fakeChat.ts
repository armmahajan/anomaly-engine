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

/** Scripted director: drafts the progression when asked about structure, otherwise a small wiki skeleton. */
const fakeDirector: TurnRunner = (request) =>
  /structure|progression/i.test(request.userMessage) ? fakeStructure(request) : fakeWiki(request);

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

const fakeBuilder: TurnRunner = (request) => {
  if (/^build from the design/i.test(request.userMessage.trim())) return fakeBuildFromDesign(request);
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
export const fakeChatRunner: TurnRunner = (request) => (request.agent?.id === "narrative" ? fakeDirector : fakeBuilder)(request);
