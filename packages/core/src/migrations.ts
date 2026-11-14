import { SCHEMA_VERSION } from "./schema.ts";

/**
 * Upgrade a stored project (or history snapshot) to the current schema
 * version. Runs before validation when loading from disk. Each step is a
 * plain function from version N to N+1; unknown input is passed through
 * unchanged so validation can report it.
 */

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

const steps: Record<number, (project: Json) => Json> = {
  /** v1 -> v2: enemy patrol stats become a one-state patrol behavior. */
  1: (project) => ({
    ...project,
    schemaVersion: 2,
    characters: (Array.isArray(project.characters) ? project.characters : []).map((c: unknown) => {
      if (!isObject(c) || c.kind !== "enemy" || !isObject(c.stats)) return c;
      const { patrolSpeed, patrolDistance } = c.stats;
      return {
        ...c,
        stats: { knockback: 350 },
        behavior: {
          initial: "patrol",
          states: {
            patrol: { action: { type: "patrol", speed: patrolSpeed, distance: patrolDistance }, transitions: [] },
          },
        },
      };
    }),
  }),

  /** v2 -> v3: spawns get stable ids (`<characterId>_<n>`). */
  2: (project) => {
    const sandbox = isObject(project.sandbox) ? project.sandbox : {};
    const counts = new Map<string, number>();
    const spawns = (Array.isArray(sandbox.spawns) ? sandbox.spawns : []).map((s: unknown) => {
      if (!isObject(s)) return s;
      const base = String(s.characterId);
      const n = (counts.get(base) ?? 0) + 1;
      counts.set(base, n);
      return { id: `${base}_${n}`, ...s };
    });
    return { ...project, schemaVersion: 3, sandbox: { ...sandbox, spawns } };
  },
};

export function migrateProject(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  let project = raw;
  while (typeof project.schemaVersion === "number" && project.schemaVersion < SCHEMA_VERSION) {
    const step = steps[project.schemaVersion];
    if (!step) break;
    project = step(project);
  }
  return project;
}
