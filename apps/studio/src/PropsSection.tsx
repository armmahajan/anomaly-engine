import type { ProjectSpec, WorldRoom } from "@anomaly/core";
import type { Session } from "./session.ts";
import type { RoomsUi } from "./RoomsView.tsx";

/** Rooms sidebar: the selected room's props (agent D): list, look, solid / visible conditions, health, handlers. */
export function PropsSection(_props: { project: ProjectSpec; session: Session; room: WorldRoom; ui: RoomsUi; setUi: (ui: RoomsUi) => void; locked: boolean }) {
  return null;
}
