import { lintProject, type Action, type Character, type Condition, type ProjectSpec, type Transition } from "@anomaly/core";

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
  if (character.kind !== "enemy") return head;
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
  const jump =
    player?.kind === "player" ? Math.round(player.stats.jumpVelocity ** 2 / (2 * sandbox.gravity)) : undefined;
  const warnings = lintProject(project);
  return [
    `Project "${project.name}" (revision ${project.revision})`,
    `Arena: ${sandbox.width}x${sandbox.height} px, gravity ${sandbox.gravity} px/s^2, y grows downward.` +
      (playerSpawn ? ` The player stands on y = ${playerSpawn.y}.` : ""),
    `Platforms (x, y, width, height): ${sandbox.platforms.map((p) => `(${p.x}, ${p.y}, ${p.width}, ${p.height})`).join(" ")}`,
    jump !== undefined ? `The player can jump about ${jump} px high.` : "",
    "Characters:",
    ...project.characters.map((c) => describeCharacter(project, c)),
    warnings.length ? `Warnings:\n${warnings.map((w) => `- ${w.message}`).join("\n")}` : "Warnings: none",
  ]
    .filter(Boolean)
    .join("\n");
}
