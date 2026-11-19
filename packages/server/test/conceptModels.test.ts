import { describe, expect, it } from "vitest";
import { FakeImageModel, OpenRouterImageModel } from "@anomaly/art";
import { applyOperation, createDefaultProject, type OperationResult, type ProjectSpec } from "@anomaly/core";
import { conceptModelFor, conceptModelIds, DEFAULT_CONCEPT_MODELS, IMAGE_MODEL_PARAMS } from "../src/index.ts";

// Concept sheets can use another image model than the rest of the pipeline: the studio offers a list
// (STUDIO_ART_CONCEPT_MODELS), the art direction's conceptModel picks one.

const ok = (r: OperationResult): ProjectSpec => {
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
};

describe("concept-sheet models", () => {
  it("offers the image model first, then the defaults or the env list, each once, never Claude", () => {
    expect(conceptModelIds({}, "openai/gpt-image-1-mini")).toEqual(["openai/gpt-image-1-mini", ...DEFAULT_CONCEPT_MODELS]);
    expect(conceptModelIds({ STUDIO_ART_CONCEPT_MODELS: "a/b, openai/gpt-image-1-mini ,anthropic/x" }, "openai/gpt-image-1-mini")).toEqual(["openai/gpt-image-1-mini", "a/b"]);
    for (const id of DEFAULT_CONCEPT_MODELS) expect(IMAGE_MODEL_PARAMS[id]).toBeDefined();
  });

  it("the art direction picks one the studio offers; anything else falls back to the default", () => {
    const a = new FakeImageModel(undefined, "a/one");
    const b = new FakeImageModel(undefined, "b/two");
    const models = { image: a, vision: null as never, concept: [{ id: "a/one", label: "One", model: a }, { id: "b/two", label: "Two", model: b }] };
    expect(conceptModelFor(models, "b/two")).toBe(b);
    expect(conceptModelFor(models, "gone/model")).toBe(a);
    expect(conceptModelFor(models, undefined)).toBe(a);
    let p = ok(applyOperation(createDefaultProject(), "setArtDirection", { changes: { conceptModel: "b/two" } }));
    expect(p.art.direction.conceptModel).toBe("b/two");
    p = ok(applyOperation(p, "setArtDirection", { changes: { conceptModel: null } }));
    expect(p.art.direction.conceptModel).toBeUndefined();
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
  });
});
