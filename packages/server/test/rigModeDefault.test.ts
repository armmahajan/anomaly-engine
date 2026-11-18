import { describe, expect, it } from "vitest";
import { artOptionsFromEnv } from "../src/index.ts";

describe("the default rig mode", () => {
  it("is cutout with real models (it won the rig A/B), vector when asked; the fake backend keeps vector", async () => {
    const real = artOptionsFromEnv({ OPENROUTER_API_KEY: "test" }, "/nonexistent");
    expect(real.defaultRigMode).toBe("cutout");
    expect(artOptionsFromEnv({ OPENROUTER_API_KEY: "test", STUDIO_ART_RIG_MODE: "vector" }, "/nonexistent").defaultRigMode).toBe("vector");
    expect(artOptionsFromEnv({ STUDIO_ART_BACKEND: "fake" }, "/nonexistent").defaultRigMode).toBeUndefined();
    await real.renderer.close();
  });
});
