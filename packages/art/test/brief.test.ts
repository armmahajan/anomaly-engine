import { describe, expect, it } from "vitest";
import { createDefaultProject, ProjectSpec, type FileRef } from "@anomaly/core";
import { FakeImageModel, FakeRenderer, FakeVisionModel, generateConcepts, wikiBrief, type ArtContext } from "../src/index.ts";

const page = {
  id: "charger_page",
  kind: "character",
  title: "The Ram",
  summary: "A charging brute of the lower halls.",
  body: "Built like a battering ram, it guards the [[hall|great hall]] and fears the [[iron_guardian]].",
  fields: { appearance: "Rust-red hide, two curled horns", motivation: "Hunger" },
  characterId: "charger",
  status: "canon",
};

function harness() {
  const project = ProjectSpec.parse({ ...createDefaultProject(), wiki: { pages: [page] } });
  const image = new FakeImageModel();
  const files = new Map<string, Buffer>();
  const ctx: ArtContext = {
    project: () => project,
    image,
    vision: new FakeVisionModel(),
    renderer: new FakeRenderer(),
    files: {
      put: async (data: Buffer, ext: string) => {
        const ref = `${files.size}.${ext}` as FileRef;
        files.set(ref, data);
        return ref;
      },
      get: async (ref: FileRef) => files.get(ref)!,
    },
    log: () => {},
    remaining: () => 1,
    spend: () => {},
  };
  return { ctx, image, project };
}

describe("concept briefs from the wiki", () => {
  it("come from the character's page (title, summary, looks fields, body as text) when no brief is given", async () => {
    const h = harness();
    expect(wikiBrief(h.project, "charger")).toBe(
      "The Ram: A charging brute of the lower halls. appearance: Rust-red hide, two curled horns. Built like a battering ram, it guards the great hall and fears the iron guardian",
    );
    expect(wikiBrief(h.project, "crawler")).toBeUndefined();
    const result = await generateConcepts(h.ctx, { characterId: "charger" });
    expect(h.image.requests[0]!.prompt).toContain("The Ram: A charging brute of the lower halls. appearance: Rust-red hide, two curled horns.");
    expect(h.image.requests[0]!.prompt).not.toContain("Hunger");
    expect(result.operations[0]).toMatchObject({ name: "createAsset", input: { asset: { brief: expect.stringContaining("The Ram") } } });
  });

  it("lose to an explicit brief", async () => {
    const h = harness();
    await generateConcepts(h.ctx, { characterId: "charger", brief: "a blue jelly" });
    expect(h.image.requests[0]!.prompt).toContain("a blue jelly");
    expect(h.image.requests[0]!.prompt).not.toContain("The Ram");
  });

  it("are trimmed", () => {
    const long = ProjectSpec.parse({ ...createDefaultProject(), wiki: { pages: [{ ...page, body: "word ".repeat(400) }] } });
    const brief = wikiBrief(long, "charger")!;
    expect(brief.length).toBeLessThanOrEqual(600);
    expect(brief.endsWith("word…")).toBe(true);
  });
});
