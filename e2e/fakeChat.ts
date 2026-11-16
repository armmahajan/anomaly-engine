import { callTools, FakeModel, runAgentTurn, say, toolCall, type TurnRunner } from "@anomaly/agent";

/** Scripted chat backend for e2e: "crawler speed N" sets the Crawler's patrol speed. */
export const fakeChatRunner: TurnRunner = (request) => {
  const speed = Number(/\d+/.exec(request.userMessage)?.[0] ?? 150);
  return runAgentTurn({
    ...request,
    model: new FakeModel([
      callTools(toolCall("updateBehavior", { characterId: "crawler", stateId: "patrol", action: { speed } })),
      say(`Set the Crawler's patrol speed to ${speed}.`),
    ]),
  });
};
