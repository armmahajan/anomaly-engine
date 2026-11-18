import { expect, type Page } from "@playwright/test";
import { exampleClips, exampleRig } from "@anomaly/core";

/** The Charger drawn with the example beetle rig and its clips (no art job needed). */
export async function rigTheCharger(page: Page, clips = true) {
  const ops = [
    { name: "createAsset", input: { asset: { id: "beetle", name: "Beetle", kind: "character", brief: "a horned beetle" }, assignTo: "charger" } },
    { name: "setRig", input: { assetId: "beetle", rig: exampleRig() } },
    ...(clips ? Object.entries(exampleClips()).map(([clipId, clip]) => ({ name: "setClip", input: { assetId: "beetle", clipId, clip } })) : []),
  ];
  const result = await page.evaluate((calls) => window.studio!.applyBatch(calls), ops);
  expect(result.ok).toBe(true);
}
