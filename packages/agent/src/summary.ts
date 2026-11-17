import { gridCols, gridRows, gridSize, lintProject, movementModel, movementParams, TILE, type Action, type Character, type Condition, type ProjectSpec, type Transition, type WorldRoom } from "@anomaly/core";

/**
 * Compact, readable descriptions of the project for the model. The raw JSON
 * is available through getCharacter when exact structure matters.
 */

const params = (primitive: Action | Condition) =>
  Object.entries(primitive)
    .filter(([k]) => k !== "type")
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");

const primitive = (p: Action | Condition) => (params(p) ? `${p.type}(${params(p)})` : p.type);
const condition = (t: Transition) => [t.when, ...(t.and ?? [])].map(primitive).join(" and ");

export function describeCharacter(project: ProjectSpec, character: Character): string {
  const spawns = project.sandbox.spawns.filter((s) => s.characterId === character.id);
  const placed = spawns.length > 0 ? spawns.map((s) => `${s.id} (${s.x}, ${s.y})`).join(", ") : "not placed";
  const stats = Object.entries(character.stats)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  const head = `- ${character.id} "${character.name}" [${character.kind}] ${character.size.width}x${character.size.height} ${character.color}; ${stats}; spawns: ${placed}`;
  if (character.kind === "player") {
    const tuning = Object.entries(character.abilities).map(([k, v]) => `${k} {${Object.entries(v).map(([f, x]) => `${f} ${x}`).join(", ")}}`);
    return `${head}\n  ability tuning: ${tuning.join("; ")}`;
  }
  const interrupts = character.behavior.interrupts.map((t, i) => `    any state: [${i}] -> ${t.to} when ${condition(t)}`);
  const states = Object.entries(character.behavior.states).map(([id, state]) => {
    const exits = state.transitions.map((t, i) => `[${i}] -> ${t.to} when ${condition(t)}`);
    return `    ${id}${id === character.behavior.initial ? " (start)" : ""}: ${primitive(state.action)}${
      exits.length ? `; ${exits.join("; ")}` : "; no transitions"
    }`;
  });
  return [`${head}; movement ${character.movement}`, "  behavior:", ...interrupts, ...states].join("\n");
}

export function summarizeProject(project: ProjectSpec): string {
  const { sandbox } = project;
  const playerSpawn = sandbox.spawns.find((s) => project.characters.find((c) => c.id === s.characterId)?.kind === "player");
  const player = project.characters.find((c) => c.kind === "player");
  const size = gridSize(sandbox.grid);
  const reach = player?.kind === "player" ? movementModel(movementParams(player, sandbox.gravity), sandbox.playerAbilities) : undefined;
  const warnings = lintProject(project);
  return [
    `Project "${project.name}" (revision ${project.revision})`,
    `Arena: ${size.width}x${size.height} px (${TILE} px tiles), gravity ${sandbox.gravity} px/s^2, y grows downward.` +
      (playerSpawn ? ` The player stands on y = ${playerSpawn.y}.` : ""),
    `Arena tiles (row 0 at the top; . empty, # solid, = ledge, - one-way, ^ hazard, % breakable):\n${sandbox.grid.rows.join("\n")}`,
    reach
      ? `Player abilities in arena playtests: ${sandbox.playerAbilities.join(", ") || "none"}. With them the player jumps ${Math.round(reach.maxHeight)} px high and crosses gaps up to ${Math.round(reach.maxGap(0))} px between platforms at the same height${reach.climbsWalls ? "; climbs walls" : ""}${reach.breaksFloors ? "; smashes breakable platforms" : ""}.`
      : "",
    "Characters:",
    ...project.characters.map((c) => describeCharacter(project, c) + (c.appearance ? ` Drawn by art asset "${c.appearance}".` : " No art yet (a colored box).")),
    ...worldSummary(project),
    ...artSummary(project),
    warnings.length ? `Warnings:\n${warnings.map((w) => `- ${w.message}`).join("\n")}` : "Warnings: none",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Biomes, their rooms and the arena's dressing, so the agent can refer to them. */
function artSummary(project: ProjectSpec): string[] {
  const biomes = project.art.assets.filter((a) => a.kind === "biome");
  if (biomes.length === 0) return ["Worlds: none yet (generateWorld makes one)."];
  const dressing = project.sandbox.dressing;
  return [
    "Worlds (biomes):",
    ...biomes.map((b) =>
      b.kind === "biome"
        ? `- ${b.id} "${b.name}": ${b.kit ? `${b.kit.quality} kit, ${b.kit.pieces.length} pieces (${b.kit.pieces.map((p) => p.id).join(", ")})` : "no kit yet"}; rooms: ${
            b.rooms.map((r) => `${r.id} (${r.composition.placements.length} placements${r.layout ? ", suggests a layout" : ""})`).join(", ") || "none"
          }`
        : "",
    ),
    dressing ? `The arena is dressed with ${dressing.biome} / ${dressing.room}.` : "The arena is plain (not dressed).",
  ];
}

/** One line per room: size, map position, doors and spawns (getRoom has the tiles). */
export function describeRoom(room: WorldRoom): string {
  const doors = room.doors.map((d) => `${d.id} ${d.side} @${d.offset}+${d.size}${d.to ? ` -> ${d.to.room}/${d.to.door}` : " (unconnected)"}`);
  const spawns = room.spawns.map((s) => `${s.id} ${s.characterId} (${s.x}, ${s.y})`);
  return (
    `- ${room.id} "${room.name}" ${gridCols(room.grid)}x${gridRows(room.grid)} tiles at map (${room.at.x}, ${room.at.y}); ` +
    `doors: ${doors.join(", ") || "none"}; enemies: ${spawns.join(", ") || "none"}` +
    (room.dressing ? `; dressed with ${room.dressing.biome}/${room.dressing.room}` : "") +
    (room.regionId ? `; region ${room.regionId}` : "")
  );
}

function worldSummary(project: ProjectSpec): string[] {
  const { world } = project;
  if (world.rooms.length === 0) return ["Game world: no rooms yet (createWorldRoom). Play happens in the arena only."];
  const start = world.start ? `starts in ${world.start.room} at (${world.start.x}, ${world.start.y})` : "no start set";
  return [
    `Game world (${TILE} px tiles; doors: offset/size in tiles; getRoom shows a room's tiles): ${start}; on death back to the ${world.rules.onDeath}; saves ${world.rules.save === "room" ? "on entering each room" : "never"}; hazards cost ${world.rules.hazardDamage}; ledges ${world.ledgeThickness} px thick.`,
    ...world.rooms.map(describeRoom),
  ];
}
