import type { ProjectSpec, RoomSpawn, WorldRoom } from "@anomaly/core";
import type { Session } from "./session.ts";

/** Rooms sidebar, under each enemy spawn (agent F): its health bar and its handlers (e.g. what its death does). */
export function SpawnDetails(_props: { project: ProjectSpec; session: Session; room: WorldRoom; spawn: RoomSpawn; locked: boolean }) {
  return null;
}
