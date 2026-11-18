import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyBatch, createDefaultProject, defaultArtDirection, type BiomeAsset, type FileRef, type OperationCall, type ProjectSpec, type WikiPage } from "@anomaly/core";
import { artDirectionStage, FakeImageModel, FakeRenderer, FakeVisionModel, KitPlan, worldKitStage, worldPrompts, worldRepaintStage, type ArtContext } from "../src/index.ts";

const page = (id: string, kind: string, title: string, summary: string, body = "", fields: Record<string, string> = {}): WikiPage => ({ id, kind, title, summary, body, fields, status: "canon" });

function harness(setup: (p: ProjectSpec) => ProjectSpec = (p) => p) {
  let project: ProjectSpec = setup(createDefaultProject());
  const files = new Map<string, Buffer>();
  const image = new FakeImageModel();
  const vision = new FakeVisionModel();
  const log: string[] = [];
  const ctx: ArtContext = {
    project: () => project,
    image,
    vision,
    renderer: new FakeRenderer(),
    files: {
      async put(data: Buffer, ext: "png" | "jpg" | "webp"): Promise<FileRef> {
        const ref = `${createHash("sha256").update(data).digest("hex").slice(0, 32)}.${ext}`;
        files.set(ref, data);
        return ref;
      },
      async get(ref: FileRef) {
        return files.get(ref)!;
      },
    },
    log: (a) => log.push(a.text),
    remaining: () => 1,
    spend: () => {},
  };
  const commit = (operations: OperationCall[]) => {
    const result = applyBatch(project, operations);
    if (!result.ok) throw new Error(`${result.error.message} ${JSON.stringify(result.error.issues)}`);
    project = result.project;
  };
  const prompts = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("\n");
  return { ctx, commit, image, vision, log, prompts, project: () => project };
}

/** A game with an overview and two very different places, each a region with its wiki page. */
function twoPlaces(p: ProjectSpec): ProjectSpec {
  return {
    ...p,
    name: "Tidewinder",
    wiki: {
      pages: [
        page("overview", "overview", "Tidewinder", "A courier crosses a world of machines and seas.", "Bright, brave and a little absurd.", { tone: "playful, sunlit", genre: "adventure platformer" }),
        page("clockwork", "place", "Frostgear", "A frozen clockwork city.", "Brass gears locked in ice, steam frozen mid-puff, ticking towers under a pale winter sun.", { mood: "brittle, ticking" }),
        page("reef", "place", "Brightshoal", "A sunlit coral reef.", "Warm shallows, swaying anemones, schools of fish over pink and orange coral.", { mood: "warm, swaying" }),
      ],
    },
    progression: {
      ...p.progression,
      regions: [
        { id: "frostgear", name: "Frostgear", rooms: 2, enemies: [], wikiPageId: "clockwork", status: "canon" },
        { id: "brightshoal", name: "Brightshoal", rooms: 2, enemies: [], wikiPageId: "reef", status: "canon" },
      ],
    },
  };
}

/** Words the old fixed kit lists put in every biome. */
const OLD_KIT_WORDS = /mushroom|stalactite|broken arch|\bchains?\b|rubble|lantern|ruined wall|root curtain|signs of past inhabitants|giant plant stalk|moss/i;

const CLOCKWORK_PLAN: KitPlan = {
  structures: [
    { name: "gear tower", look: "a brass tower of stacked frozen gears", role: "standing" },
    { name: "piston column", look: "an iced piston column", role: "standing" },
    { name: "clock face wall", look: "a cracked clock face in a brass frame", role: "standing" },
    { name: "boiler", look: "a frost-covered boiler", role: "standing" },
    { name: "chimney stack", look: "a riveted chimney frozen mid-puff", role: "standing" },
    { name: "pendulum", look: "a giant iced pendulum", role: "hanging" },
    { name: "icicle gears", look: "gears hung with icicles", role: "hanging" },
    { name: "cogwheel arch", look: "half a cogwheel standing on end", role: "standing" },
    { name: "brass girder", look: "a long riveted brass girder", role: "span" },
  ],
  props: [
    { name: "furnace lamp", look: "a glowing coal furnace lamp", role: "light" },
    { name: "spring coil", look: "a loose frozen spring", role: "ground" },
    { name: "loose cogs", look: "a few small cogs in snow", role: "ground" },
    { name: "valve wheel", look: "a red valve wheel", role: "ground" },
    { name: "frozen gauge", look: "a pressure gauge in ice", role: "ground" },
    { name: "snow drift", look: "a small snow drift", role: "ground" },
    { name: "key winder", look: "a wind-up key", role: "ground" },
    { name: "steam vent", look: "a vent with a frozen puff", role: "ground" },
    { name: "hanging bell", look: "a small brass bell", role: "hanging" },
  ],
  ground: "iced brass plates with rivets",
};

describe("the art direction step", () => {
  it("writes the direction from the wiki's overview, places and characters", async () => {
    const h = harness(twoPlaces);
    const result = await artDirectionStage(h.ctx);
    const prompt = h.prompts(h.vision.requests[0]!);
    expect(prompt).toContain("Write the art direction for this game");
    expect(prompt).toContain("Overview. Tidewinder: A courier crosses a world of machines and seas");
    expect(prompt).toContain("tone: playful, sunlit");
    expect(prompt).toContain("Frostgear: A frozen clockwork city");
    expect(prompt).toContain("Brightshoal: A sunlit coral reef");
    expect(prompt).toMatch(/never name other games/);
    expect(result.operations.map((o) => o.name)).toEqual(["setArtDirection"]);
    h.commit(result.operations);
    const direction = h.project().art.direction;
    expect(direction.style).toContain("Tidewinder");
    expect(direction.style).not.toBe(defaultArtDirection().style);
    expect(direction.palette).toContain("#3a6ea5");
    // Written once: it is not a default any more, so another run keeps it.
    const again = await artDirectionStage(h.ctx);
    expect(again.operations).toEqual([]);
    expect(h.vision.requests).toHaveLength(1);
  });

  it("never replaces a direction the creator edited", async () => {
    const h = harness((p) => {
      const q = twoPlaces(p);
      return { ...q, art: { ...q.art, direction: { ...q.art.direction, style: "Chunky woodcut prints in two inks." } } };
    });
    const result = await artDirectionStage(h.ctx);
    expect(result.operations).toEqual([]);
    expect(result.summary).toMatch(/kept/);
    expect(h.vision.requests).toHaveLength(0);
  });

  it("needs an overview to write from", async () => {
    const h = harness();
    await expect(artDirectionStage(h.ctx)).rejects.toThrow(/overview/);
  });
});

describe("kits planned from the place", () => {
  it("send sheet prompts that enumerate the place's own items, different per place, with none of the old fixed list", async () => {
    const sheets: Record<string, { structures: string; props: string; ground: string }> = {};
    for (const [name, theme] of [
      ["Frostgear", "a frozen clockwork city"],
      ["Brightshoal", "a sunlit coral reef"],
    ] as const) {
      const h = harness(twoPlaces);
      if (name === "Frostgear") h.vision.replies.push(JSON.stringify(CLOCKWORK_PLAN));
      h.commit((await worldKitStage(h.ctx, { theme, name })).operations);
      const plan = h.prompts(h.vision.requests[0]!);
      expect(plan).toContain("Plan the kit of sprites");
      expect(plan).toContain(`Place: ${theme}`);
      // The region's wiki page goes with it.
      expect(plan).toContain(name === "Frostgear" ? "Brass gears locked in ice" : "swaying anemones");
      const prompt = (what: string) => h.image.requests.find((r) => r.prompt.startsWith(what))!.prompt;
      sheets[name] = { structures: prompt("Sprite sheet: a 3x3 grid of nine separate LARGE"), props: prompt("Sprite sheet: a 3x3 grid of nine separate small props"), ground: prompt("Seamless tileable") };
      for (const p of Object.values(sheets[name]!)) expect(p).not.toMatch(OLD_KIT_WORDS);
      expect(sheets[name]!.structures).toContain("not pixel art");
      expect(sheets[name]!.props).toContain("smooth, clean anti-aliased edges".replace("smooth", "Smooth"));
      // The labeller is told what was asked for.
      const label = h.prompts(h.vision.requests.find((r) => h.prompts(r).includes("Non-empty cells"))!);
      expect(label).toContain("The sheets were asked to hold");
    }
    const frost = sheets.Frostgear!;
    expect(frost.structures).toContain("1. gear tower: a brass tower of stacked frozen gears (stands upright on its own base)");
    expect(frost.structures).toContain("9. brass girder: a long riveted brass girder (long and thin, lying flat, with nothing under it");
    expect(frost.structures).toContain("pendulum: a giant iced pendulum (hangs down from above");
    expect(frost.props).toContain("furnace lamp: a glowing coal furnace lamp (gives off light)");
    expect(frost.ground).toContain("iced brass plates with rivets");
    const reef = sheets.Brightshoal!;
    expect(reef.structures).toContain("coral");
    expect(reef.structures).not.toContain("gear tower");
    expect(reef.props).not.toContain("furnace lamp");
    expect(frost.structures).not.toContain("coral");
  });

  it("re-plans when the structures or props are repainted, and not for the ground", async () => {
    const h = harness(twoPlaces);
    h.commit((await worldKitStage(h.ctx, { theme: "a frozen clockwork city", name: "Frostgear" })).operations);
    const biome = h.project().art.assets.find((a) => a.kind === "biome") as BiomeAsset;
    const plans = () => h.vision.requests.filter((r) => h.prompts(r).includes("Plan the kit of sprites")).length;
    expect(plans()).toBe(1);
    h.commit((await worldRepaintStage(h.ctx, { biomeId: biome.id, part: "props" })).operations);
    expect(plans()).toBe(2);
    expect(h.image.requests.at(-1)!.prompt).toContain("one per cell in reading order");
    h.commit((await worldRepaintStage(h.ctx, { biomeId: biome.id, part: "ground" })).operations);
    expect(plans()).toBe(2);
  });

  it("asks again when a plan lacks a role composition needs", async () => {
    const h = harness(twoPlaces);
    const noSpan = { ...CLOCKWORK_PLAN, structures: CLOCKWORK_PLAN.structures.map((s) => ({ ...s, role: s.role === "span" ? "standing" : s.role })) };
    h.vision.replies.push(JSON.stringify(noSpan));
    await worldKitStage(h.ctx, { theme: "a frozen clockwork city", name: "Frostgear" });
    expect(h.prompts(h.vision.requests[1]!)).toMatch(/exactly one structure must have role span/);
  });

  it("without a plan, prompts name only the roles, never a setting's contents", () => {
    const prompts = worldPrompts("a place", defaultArtDirection());
    for (const p of Object.values(prompts)) expect(p).not.toMatch(OLD_KIT_WORDS);
    expect(prompts.structures).toMatch(/hang down from above/);
    expect(prompts.structures).toMatch(/one bare horizontal beam/);
    expect(prompts.props).toMatch(/give off light/);
  });
});

describe("art prompt sources", () => {
  /** Setting content one particular game is known for; the creator's wiki decides what a place holds. */
  const SETTING = /mushroom|stalactite|broken arch|\bruin(s|ed)?\b|insect|melanchol|gloomy|underground|cavern|lantern|\bchains?\b|rubble|root curtain|\bmoss\b|fung(us|al|i)|pale mask|cathedral|crypt|kingdom/i;
  const sources = (dir: string, skip: string[]) =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !skip.includes(f))
      .map((f) => ({ file: join(dir, f), text: readFileSync(join(dir, f), "utf8") }));

  it("hard-code no genre or setting content (fakes and the old default kept for recognition aside)", () => {
    const files = [
      ...sources(join(import.meta.dirname, "../src"), ["fake.ts", "rigFixtures.ts"]),
      ...sources(join(import.meta.dirname, "../../core/src/art"), []),
    ];
    expect(files.length).toBeGreaterThan(10);
    for (const { file, text } of files) {
      // The old default is kept only so stored projects still count as "not chosen yet".
      const checked = text.replace(/export const LEGACY_DEFAULT_STYLES[\s\S]*?\];/, "");
      const hits = checked.split("\n").filter((line) => SETTING.test(line));
      expect(hits, file).toEqual([]);
    }
  });
});
