import { describe, expect, it } from "vitest";
import { sameJob } from "./ArtJobButton.tsx";

describe("an art job button's own job", () => {
  it("is the same stage for the same subject: drawing one weapon, room's props or screen leaves the others' buttons free", () => {
    expect(sameJob({ stage: "weaponArt", weaponId: "blade" }, { stage: "weaponArt", weaponId: "blade" })).toBe(true);
    expect(sameJob({ stage: "weaponArt", weaponId: "blade" }, { stage: "weaponArt", weaponId: "pistol" })).toBe(false);
    expect(sameJob({ stage: "propArt", worldRoomId: "a" }, { stage: "propArt", worldRoomId: "b" })).toBe(false);
    expect(sameJob({ stage: "modalArt", modalId: "title" }, { stage: "modalArt", modalId: "title" })).toBe(true);
    expect(sameJob({ stage: "itemArt" }, { stage: "itemArt" })).toBe(true);
    expect(sameJob({ stage: "modalArt", modalId: "title" }, { stage: "itemArt" })).toBe(false);
  });
});
