import { callTools, FakeModel, runAgentTurn, say, toolCall, type TurnRunner } from "@anomaly/agent";

const page = (id: string, kind: string, title: string, extra: Record<string, unknown> = {}) =>
  toolCall("createWikiPage", { page: { id, kind, title, ...extra } });

/** Scripted narrative director: drafts a small wiki skeleton from any pitch. */
const fakeDirector: TurnRunner = (request) =>
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

/** Scripted build assistant: "crawler speed N" sets the Crawler's patrol speed. */
const fakeBuilder: TurnRunner = (request) => {
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
