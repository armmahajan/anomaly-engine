import { describe, expect, it } from "vitest";
import { artOptionsFromEnv } from "../src/index.ts";

describe("the default rig mode", () => {
  it("is vector (the full pipeline) with real models, traced or cutout when asked; the fake backend keeps vector", async () => {
    const real = artOptionsFromEnv({ OPENROUTER_API_KEY: "test" }, "/nonexistent");
    expect(real.defaultRigMode).toBe("vector");
    expect(artOptionsFromEnv({ OPENROUTER_API_KEY: "test", STUDIO_ART_RIG_MODE: "traced" }, "/nonexistent").defaultRigMode).toBe("traced");
    expect(artOptionsFromEnv({ OPENROUTER_API_KEY: "test", STUDIO_ART_RIG_MODE: "cutout" }, "/nonexistent").defaultRigMode).toBe("cutout");
    expect(artOptionsFromEnv({ STUDIO_ART_BACKEND: "fake" }, "/nonexistent").defaultRigMode).toBeUndefined();
    await real.renderer.close();
  });
});
