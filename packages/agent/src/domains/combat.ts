import { z } from "zod";
import type { DomainTools } from "./types.ts";

/** The build assistant's tools for enemy combat (one entry per core operation of that domain). */
export const combatTools: DomainTools<"setSpawnHealthBar"> = {
  descriptions: {
    setSpawnHealthBar:
      "Show a titled health bar at the top of the screen while one enemy spawn is alive in the current room (any enemy can have one); healthBar null hides it. A spawn's handlers (addHandler with spawnId) can react to its death, e.g. on enemyKilled do shake, slowMotion, setFlag.",
  },
  schemas: {
    setSpawnHealthBar: z.strictObject({ roomId: z.string(), spawnId: z.string(), healthBar: z.strictObject({ title: z.string() }).nullable() }),
  },
  summary: (project) => {
    const bars = project.world.rooms.flatMap((r) => r.spawns.flatMap((s) => (s.healthBar ? [`${r.id}/${s.id} "${s.healthBar.title}"`] : [])));
    return bars.length ? [`Health bars: ${bars.join(", ")}.`] : [];
  },
};
