import { describe, expect, it } from "vitest";
import {
  artDirectionWanted,
  COMPOSITION_LIMITS,
  compositionBudgets,
  compositionLimitsText,
  createDefaultProject,
  defaultArtDirection,
  fixtureReferenceProject,
  fixtureSliceProject,
  gameArtPlan,
  isDefaultArtDirection,
  LEGACY_DEFAULT_STYLES,
  limitComposition,
  type ProjectSpec,
} from "../src/index.ts";

/** Phrases of the old default (one particular game's look) that no default may carry again. */
const OLD_DEFAULT_PHRASES = ["insect", "underground", "melancholy", "gloomy", "pale masks", "lantern", "glowing eyes", "kingdom", "desaturated"];

describe("the default art direction", () => {
  it("describes how the art is made, with no setting, creatures or mood", () => {
    const { style } = defaultArtDirection();
    for (const phrase of OLD_DEFAULT_PHRASES) expect(style.toLowerCase()).not.toContain(phrase);
    expect(style).toMatch(/hand-drawn 2D game art/i);
    expect(createDefaultProject().art.direction.style).toBe(style);
  });

  it("counts today's and the old default as not chosen; anything else as chosen", () => {
    expect(isDefaultArtDirection(defaultArtDirection())).toBe(true);
    expect(isDefaultArtDirection({ style: LEGACY_DEFAULT_STYLES[0]! })).toBe(true);
    expect(LEGACY_DEFAULT_STYLES[0]).toMatch(/insect-kingdom/);
    expect(isDefaultArtDirection({ style: "Chunky woodcut prints in two inks." })).toBe(false);
  });
});

describe("the game-art plan's direction step", () => {
  const withStyle = (p: ProjectSpec, style: string): ProjectSpec => ({ ...p, art: { ...p.art, direction: { ...p.art.direction, style } } });

  it("comes first while the look is a default and the wiki has an overview", () => {
    const p = fixtureReferenceProject();
    expect(artDirectionWanted(p)).toBe(true);
    const plan = gameArtPlan(p);
    expect(plan[0]).toMatchObject({ id: "direction", kind: "direction", request: { stage: "artDirection" } });
    expect(plan.filter((s) => s.kind === "direction")).toHaveLength(1);
    // The old default counts too.
    expect(gameArtPlan(withStyle(p, LEGACY_DEFAULT_STYLES[0]!))[0]!.id).toBe("direction");
  });

  it("is left out once the creator chose a look, or without an overview to write it from", () => {
    const p = fixtureReferenceProject();
    expect(gameArtPlan(withStyle(p, "Chunky woodcut prints in two inks.")).some((s) => s.kind === "direction")).toBe(false);
    const noOverview = { ...p, wiki: { pages: p.wiki.pages.filter((pg) => pg.kind !== "overview") } };
    expect(gameArtPlan(noOverview).some((s) => s.kind === "direction")).toBe(false);
    expect(gameArtPlan(fixtureSliceProject()).some((s) => s.kind === "direction")).toBe(false); // no wiki
  });

  it("biome themes are the place in the creator's words, without the art direction's style", () => {
    const p = fixtureReferenceProject();
    const kits = gameArtPlan(p).filter((s) => s.kind === "biome");
    expect(kits.length).toBeGreaterThan(1);
    const spire = kits.find((s) => s.id === "biome:spire")!;
    expect(spire.request.brief).toContain("The Spire: A drowned cistern");
    for (const kit of kits) expect(kit.request.brief).not.toContain(p.art.direction.style.slice(0, 30));
  });
});

describe("composition limits", () => {
  const room = { width: 1600, height: 736, view: 448 };
  const piece = (id: string, size: number, kind: "structure" | "decor" | "hanging" = "structure", aspect = 0.5) => ({ id, size, width: Math.round(aspect * 200), height: 200, kind });
  const pieces = [piece("tower", 500), piece("rock", 40, "decor", 1), piece("drape", 300, "hanging"), piece("wide", 120, "structure", 6)];

  it("are named per layer, with no pieces in the far layer and mid pieces small against the view", () => {
    expect(COMPOSITION_LIMITS.far.perView).toBe(0);
    expect(COMPOSITION_LIMITS.mid.maxHeight).toBeLessThanOrEqual(0.45);
    const b = compositionBudgets(room);
    expect(b.mid.maxHeight).toBe(Math.round(0.4 * 448));
    expect(b.mid.count).toBe(Math.round(COMPOSITION_LIMITS.mid.perView * (1600 / (448 * 16 / 9))));
    expect(compositionLimitsText(room)).toContain(`mid: at most ${b.mid.count} pieces, each at most ${b.mid.maxHeight}px tall`);
  });

  it("scale oversized pieces down to their layer's caps (height and width)", () => {
    const out = limitComposition(
      [
        { id: "a", piece: "tower", layer: "mid" as const, scale: 2 },
        { id: "b", piece: "wide", layer: "mid" as const, scale: 1 },
        { id: "c", piece: "rock", layer: "play" as const, scale: 1 },
      ],
      pieces,
      room,
    );
    const b = compositionBudgets(room);
    const a = out.placements.find((p) => p.id === "a")!;
    expect(500 * a.scale).toBeLessThanOrEqual(b.mid.maxHeight);
    const wide = out.placements.find((p) => p.id === "b")!;
    expect(120 * wide.scale * 6).toBeLessThanOrEqual(b.mid.maxWidth);
    expect(out.placements.find((p) => p.id === "c")!.scale).toBe(1); // small enough already
    expect(out.scaled.sort()).toEqual(["a", "b"]);
  });

  it("keep the composer's first pieces within each layer's count and coverage, and drop the far layer", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, piece: "tower", layer: "mid" as const, scale: 1 }));
    const fronts = Array.from({ length: 6 }, (_, i) => ({ id: `f${i}`, piece: "drape", layer: "front" as const, scale: 1 }));
    const out = limitComposition([{ id: "x", piece: "rock", layer: "far" as const, scale: 1 }, ...many, ...fronts], pieces, room);
    const b = compositionBudgets(room);
    const mids = out.placements.filter((p) => p.layer === "mid");
    expect(mids.length).toBeLessThanOrEqual(b.mid.count);
    expect(mids.map((p) => p.id)).toEqual(many.slice(0, mids.length).map((p) => p.id)); // first ones kept
    expect(out.placements.filter((p) => p.layer === "front").length).toBeLessThanOrEqual(b.front.count);
    expect(out.placements.some((p) => p.layer === "far")).toBe(false);
    expect(out.dropped).toContain("x");
    // Coverage: the kept mid pieces' boxes stay within the budget.
    const area = mids.reduce((sum, p) => sum + (500 * p.scale) ** 2 * 0.5, 0);
    expect(area).toBeLessThanOrEqual(b.mid.maxArea + 1);
  });

  it("leave a restrained composition alone", () => {
    const placements = [
      { id: "a", piece: "tower", layer: "mid" as const, scale: 0.3 },
      { id: "b", piece: "rock", layer: "play" as const, scale: 1 },
      { id: "c", piece: "drape", layer: "front" as const, scale: 0.5 },
    ];
    const out = limitComposition(placements, pieces, room);
    expect(out.placements).toEqual(placements);
    expect(out.scaled).toEqual([]);
    expect(out.dropped).toEqual([]);
  });
});
