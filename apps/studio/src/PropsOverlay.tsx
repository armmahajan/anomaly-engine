import type { ProjectSpec, WorldRoom } from "@anomaly/core";
import type { Session } from "./session.ts";
import type { RoomsUi } from "./RoomsView.tsx";

export interface PropsOverlayProps {
  project: ProjectSpec;
  session: Session;
  room: WorldRoom;
  ui: RoomsUi;
  setUi: (ui: RoomsUi) => void;
  locked: boolean;
  /** Screen px per room px; the overlay box covers the room exactly. */
  scale: number;
  /** The Prop tool is selected: the overlay takes the pointer (place, select, move, resize). */
  active: boolean;
}

/** Over the room painter (agent D): draws the room's props and edits them with the Prop tool. */
export function PropsOverlay(_props: PropsOverlayProps) {
  return null;
}
