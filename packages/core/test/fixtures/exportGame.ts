import { exampleClips, exampleRig, fixtureSliceProject, ProjectSpec } from "../../src/index.ts";

/** A content-hash file ref made of one repeated character, e.g. ref("a") = "aaaa…a.png". */
export const ref = (c: string) => `${c.repeat(40)}.png`;

/** Files the game draws (and must be exported). */
export const USED_REFS = {
  heroCutout: ref("1"),
  backdrop: ref("2"),
  ground: ref("3"),
  pillar: ref("4"),
  titleImage: ref("5"),
};
/** Files the project holds that the game never draws (and must not be exported). */
export const UNUSED_REFS = {
  concept: ref("a"),
  chosen: ref("b"),
  preview: ref("c"),
  clipPreview: ref("d"),
  ghostCutout: ref("e"),
  swampBackdrop: ref("f"),
  swampGround: ref("0"),
};
export const SECRET_TEXT = "the-secret-wiki-sentence";

const composition = {
  palette: { ambient: "#8090a0", fog: "#3a5068", light: "#ffd9a0", shadow: "#05070a" },
  placements: [{ id: "pl_1", piece: "s0_pillar", layer: "mid", x: 300, y: 600, scale: 1, flip: false }],
  lights: [],
  fog: { mid: 0.5, back: 0.3, play: 0.2 },
  rays: [],
  dust: { color: "#ffe2b0", amount: 60 },
};

const kit = (backdrop: string, ground: string, pillar: string) => ({
  backdrop,
  ground,
  quality: "draft",
  pieces: [{ id: "s0_pillar", file: pillar, name: "Pillar", kind: "structure", width: 100, height: 400, size: 420 }],
});

/**
 * The example game (fixtureSliceProject) with art: a cutout player, a dressed start room, a title
 * image; plus everything an export must leave out: an unused character and biome, concepts,
 * previews, a wiki page and the Architect's plan text.
 */
export function artfulGame(name = "Descent: The Return!"): ProjectSpec {
  const base = fixtureSliceProject();
  const startRoom = base.world.start!.room;
  const cutout = (file: string) => ({ ...exampleRig(), mode: "cutout", source: { file, scale: 1, anchor: [0, 0] } });
  const json = JSON.parse(JSON.stringify(base));
  json.name = name;
  json.characters = json.characters.map((c: { kind: string }) => (c.kind === "player" ? { ...c, appearance: "hero_art" } : c));
  json.wiki = { pages: [{ id: "overview", kind: "overview", title: "Overview", summary: "", body: SECRET_TEXT, fields: {}, status: "canon" }] };
  json.art.assets = [
    {
      id: "hero_art",
      name: "Hero",
      kind: "character",
      brief: "a brief nobody should ship",
      concepts: [{ file: UNUSED_REFS.concept, prompt: "concept prompt", model: "m", cost: 0.01, at: "2026-11-18T00:00:00Z" }],
      chosen: { sheet: 0, cell: 0, file: UNUSED_REFS.chosen },
      rig: cutout(USED_REFS.heroCutout),
      preview: { file: UNUSED_REFS.preview },
      clips: exampleClips(),
      clipPreviews: { idle: UNUSED_REFS.clipPreview },
    },
    { id: "ghost_art", name: "Ghost", kind: "character", brief: "unused", rig: cutout(UNUSED_REFS.ghostCutout) },
    {
      id: "caves",
      name: "Caves",
      kind: "biome",
      brief: "damp caves",
      kit: kit(USED_REFS.backdrop, USED_REFS.ground, USED_REFS.pillar),
      rooms: [
        { id: "hall", name: "Hall", composition, layout: null, cost: 0.02, at: "2026-11-18T00:00:00Z" },
        { id: "spare", name: "Spare", composition, layout: null, cost: 0.02, at: "2026-11-18T00:00:00Z" },
      ],
    },
    { id: "swamp", name: "Swamp", kind: "biome", brief: "unused", kit: kit(UNUSED_REFS.swampBackdrop, UNUSED_REFS.swampGround, UNUSED_REFS.swampBackdrop), rooms: [] },
  ];
  json.world.rooms = json.world.rooms.map((r: { id: string }) => (r.id === startRoom ? { ...r, dressing: { biome: "caves", room: "hall" } } : r));
  json.world.modals = json.world.modals.map((m: { id: string }) => (m.id === "title" ? { ...m, image: USED_REFS.titleImage } : m));
  return ProjectSpec.parse(json);
}
