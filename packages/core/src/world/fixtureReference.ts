import { ProjectSpec as ProjectSchema, type ProjectSpec } from "../schema.ts";
import { fixtureSliceProject, SLICE_GATE_ABILITY } from "./fixtureSlice.ts";

/**
 * The golden reference game for the integration proof: the fixture slice
 * with its design documents filled in and its rooms in regions, as a small
 * MVP-shaped game (three regions, seven rooms, a key gate, an ability gate,
 * a save spot, a heavy fight, title, ending, map). Everything checks against
 * it: the progression lint, the logic-aware checker, gate checks, the art plan.
 *
 *   undercroft (entrance, hall) --hatch key--> spire (cistern, spikes, bridge, sanctum)
 *   spire --double jump (from the guardian)--> summit (summit, the ending)
 */

export const REFERENCE_REGIONS: Record<string, string[]> = {
  undercroft: ["entrance", "hall"],
  spire: ["cistern", "spikes", "bridge", "sanctum"],
  summit: ["summit"],
};

const page = (id: string, kind: string, title: string, summary: string, body: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind,
  title,
  summary,
  body,
  fields: {},
  status: "canon",
  ...extra,
});

export function fixtureReferenceProject(): ProjectSpec {
  const slice = fixtureSliceProject();
  const regionOf = (room: string) => Object.entries(REFERENCE_REGIONS).find(([, rooms]) => rooms.includes(room))?.[0];
  return ProjectSchema.parse({
    ...slice,
    name: "Descent",
    wiki: {
      pages: [
        page("overview", "overview", "Descent", "A wanderer climbs down into a sealed undercroft and back up a broken spire.", "Find the way down through the [[undercroft]], cross the [[spire]] and its [[guardian]], and reach the [[summit]]."),
        page("undercroft", "place", "The Undercroft", "Damp stone halls under the old city, shut by a locked hatch.", "Quiet, cold blue-grey stone; lanterns long gone out. A brass key lies on a ledge near the entrance; the hatch in the hall needs it."),
        page("spire", "place", "The Spire", "A drowned cistern, a spike pit and a bridge rising to the guardian's sanctum.", "Rust and green copper, dripping water, warm light from the sanctum. The guardian has sealed it for an age."),
        page("summit", "place", "The Summit", "An altar under an open sky, reached only by those who can jump twice.", "Pale gold light, wind, the end of the climb."),
        page("wanderer", "character", "The Wanderer", "A small cloaked traveller with a short sword.", "Light on their feet; carries a short blade and nothing else.", { characterId: "player" }),
        page("crawler", "character", "Crawler", "A beetle that patrols the cistern.", "Squat armored beetle with a single curved horn, dull green shell.", { characterId: "crawler" }),
        page("guardian", "character", "The Iron Guardian", "A heavy armored sentinel that seals the sanctum.", "Tall iron armor with a cleaver; heavy, slow, sends quakes through the floor when hurt.", { characterId: "guardian" }),
      ],
    },
    progression: {
      start: "undercroft",
      ending: "summit",
      abilities: [
        { id: "hatch_key", name: "Hatch key", mechanic: "key", obtainedIn: { regionId: "undercroft", source: "pickup", requires: [] }, status: "canon" },
        { id: SLICE_GATE_ABILITY, name: "Double jump", mechanic: "double_jump", obtainedIn: { regionId: "spire", source: "boss", requires: [] }, status: "canon" },
      ],
      regions: [
        { id: "undercroft", name: "The Undercroft", rooms: 2, enemies: [], wikiPageId: "undercroft", status: "canon" },
        { id: "spire", name: "The Spire", rooms: 4, enemies: ["crawler"], boss: "guardian", wikiPageId: "spire", status: "canon" },
        { id: "summit", name: "The Summit", rooms: 1, enemies: [], wikiPageId: "summit", status: "canon" },
      ],
      connections: [
        { id: "down_the_hatch", from: "undercroft", to: "spire", oneWay: true, requires: ["hatch_key"], status: "canon" },
        { id: "up_to_summit", from: "spire", to: "summit", oneWay: false, requires: [SLICE_GATE_ABILITY], status: "canon" },
      ],
      beats: [],
    },
    world: { ...slice.world, rooms: slice.world.rooms.map((r) => ({ ...r, regionId: regionOf(r.id) })) },
  });
}
