import { describe, expect, it } from "vitest";
import { solidPng } from "@anomaly/art";
import { ClaudeCodeVisionModel } from "../src/art/claudeCodeVision.ts";

// Uses the machine's Claude Code login. Run with: ANOMALY_LIVE_CLAUDE=1 npx vitest run claudeCodeVision.live
describe.skipIf(!process.env.ANOMALY_LIVE_CLAUDE)("ClaudeCodeVisionModel (live)", () => {
  it("describes a small PNG as JSON", { timeout: 120_000 }, async () => {
    const vision = new ClaudeCodeVisionModel({ model: process.env.STUDIO_ART_VISION_MODEL || undefined });
    const reply = await vision.complete({
      system: "You name the main color of images.",
      content: [{ type: "image", image: solidPng(64, 64, [220, 30, 30]) }, { type: "text", text: 'Reply as {"color": "<one word>"}.' }],
      json: true,
    });
    expect((JSON.parse(reply.text) as { color: string }).color.toLowerCase()).toMatch(/red|crimson|scarlet/);
    expect(reply.usage.cost).toBe(0);
    expect(reply.usage.promptTokens).toBeGreaterThan(0);
  });
});
