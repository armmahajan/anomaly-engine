import { describe, expect, it } from "vitest";
import { createDefaultProject, fixtureAnimatedProject, type EnemyCharacter } from "@anomaly/core";
import { stateChoices, type HandlerPlace } from "../objects/objectRefs.ts";
import { lookSummary, stateLookStage } from "./stateLook.ts";

const project = fixtureAnimatedProject();
const arena = project.world.rooms.find((r) => r.id === "arena")!;
const enemy = (p: typeof project, id: string) => p.characters.find((c) => c.id === id) as EnemyCharacter;

describe("state looks in the studio", () => {
  it("offers the states a stateEntered can wait for: a spawn's own enemy's, a `from` spawn's, else every enemy's", () => {
    const onSpawn: HandlerPlace = { room: arena, self: { kind: "spawn", id: "charger_1" } };
    const inRoom: HandlerPlace = { room: arena, self: null };
    expect(stateChoices(project, { type: "stateEntered" }, onSpawn)).toEqual(["patrol", "windup", "charge", "recover"]);
    expect(stateChoices(project, { type: "stateEntered", from: { kind: "spawn", spawn: "crawler_1" } }, inRoom)).toEqual(["rest", "fire"]);
    expect(stateChoices(project, { type: "stateEntered" }, { room: null, self: null })).toEqual(["rest", "fire", "patrol", "windup", "charge", "recover"]);
  });

  it("previews a state's look on the character stage, playing that state's clip; nothing for an enemy not drawn yet", () => {
    const look = { aura: { color: "#ff0000", size: 12, pulse: 0.3 } };
    expect(stateLookStage(project, enemy(project, "charger"), "windup", look)).toEqual({
      mode: "character",
      characterId: "charger",
      clip: "idle",
      time: null,
      speed: 1,
      flip: false,
      bones: false,
      onion: { image: null, alpha: 0 },
      look,
    });
    const plain = createDefaultProject();
    expect(stateLookStage(plain, enemy(plain, "charger"), "windup", look)).toBeNull();
    expect(lookSummary(undefined)).toBe("none");
    expect(lookSummary({ tint: { color: "#ff0000", amount: 0.5 }, brightness: 2 })).toBe("tint, brightness");
  });
});
