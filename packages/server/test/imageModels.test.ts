import { describe, expect, it } from "vitest";
import { FakeImageModel, OpenRouterImageModel } from "@anomaly/art";
import { applyOperation, createDefaultProject, type OperationResult, type ProjectSpec } from "@anomaly/core";
import { DEFAULT_IMAGE_CHOICES, IMAGE_MODEL_PARAMS, imageChoiceIds, imageModelFor } from "../src/index.ts";

// The creator picks the image model for all art: the studio offers a list (STUDIO_ART_IMAGE_CHOICES), the art
// direction's imageModel picks one; a step the pick can't do (a reference image, a transparent background) uses the default.

const ok = (r: OperationResult): ProjectSpec => {
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};

describe("image model choices", () => {
  it("offers the image model first, then the defaults or the env list, each once, never Claude", () => {
    expect(imageChoiceIds({}, "openai/gpt-image-1-mini")).toEqual(["openai/gpt-image-1-mini", ...DEFAULT_IMAGE_CHOICES]);
    expect(imageChoiceIds({ STUDIO_ART_IMAGE_CHOICES: "a/b, openai/gpt-image-1-mini ,anthropic/x" }, "openai/gpt-image-1-mini")).toEqual(["openai/gpt-image-1-mini", "a/b"]);
    for (const id of DEFAULT_IMAGE_CHOICES) expect(IMAGE_MODEL_PARAMS[id]).toBeDefined();
  });

  it("the art direction picks one the studio offers for every step; steps it can't do go to the default", async () => {
    const fallback = new FakeImageModel(undefined, "a/default");
    const picked = new FakeImageModel(undefined, "b/picked");
    // b/picked takes no reference images and no transparent backgrounds.
    Object.assign(picked, { accepts: (r: { references?: unknown[]; transparent?: boolean }) => !r.references?.length && !r.transparent });
    const models = { image: fallback, vision: null as never, imageChoices: [{ id: "a/default", label: "A", model: fallback }, { id: "b/picked", label: "B", model: picked }] };
    expect(imageModelFor(models, undefined)).toBe(fallback);
    expect(imageModelFor(models, "gone/model")).toBe(fallback);
    const image = imageModelFor(models, "b/picked");
    expect((await image.generate({ prompt: "a concept sheet" })).model).toBe("b/picked");
    expect((await image.generate({ prompt: "a flat redraw", references: [Buffer.from("x")] })).model).toBe("a/default");
    expect((await image.generate({ prompt: "a prop", transparent: true })).model).toBe("a/default");
    let p = ok(applyOperation(createDefaultProject(), "setArtDirection", { changes: { imageModel: "b/picked" } }));
    expect(p.art.direction.imageModel).toBe("b/picked");
    p = ok(applyOperation(p, "setArtDirection", { changes: { imageModel: null } }));
    expect(p.art.direction.imageModel).toBeUndefined();
  });

  it("a model sends only the request fields it accepts", async () => {
    const sent: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("x").toString("base64") }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const reference = Buffer.from("ref");
    for (const [id, supports] of [["meta/muse-image", []], ["black-forest-labs/flux.2-pro", ["aspect_ratio", "n", "input_references"]], ["openai/gpt-image-1-mini", undefined]] as const) {
      const model = new OpenRouterImageModel({ apiKey: "k", fetch: fetchImpl }, id, id.startsWith("openai/") ? { quality: "low" } : {}, supports);
      await model.generate({ prompt: "a lever", references: [reference] });
    }
    expect(Object.keys(sent[0]!).sort()).toEqual(["model", "prompt"]);
    expect(Object.keys(sent[1]!).sort()).toEqual(["aspect_ratio", "input_references", "model", "n", "prompt"]);
    expect(Object.keys(sent[2]!).sort()).toEqual(["aspect_ratio", "input_references", "model", "n", "prompt", "quality"]);
    const muse = new OpenRouterImageModel({ apiKey: "k", fetch: fetchImpl }, "meta/muse-image", {}, IMAGE_MODEL_PARAMS["meta/muse-image"]);
    expect(muse.accepts({ prompt: "x" })).toBe(true);
    expect(muse.accepts({ prompt: "x", references: [reference] })).toBe(false);
    expect(muse.accepts({ prompt: "x", transparent: true })).toBe(false);
  });
});
