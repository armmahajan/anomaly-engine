import type { ArchitectState, ArtState, LiveState, ProjectSpec } from "@anomaly/core";
import type { Session } from "../session.ts";
import { RoomsLive } from "../LiveStatus.tsx";
import { PlanView } from "./PlanView.tsx";
import { RunPanel } from "./RunPanel.tsx";
import "./architect.css";

/**
 * The Architect tab: the plan as an editable document in the main pane (game
 * guidance, region notes, room cards, links, pins) and the run in the sidebar
 * (build/continue/stop, stages with pause-after toggles, issues, activity).
 * Edits go through the plan operations (session.applyOperation: one undo step
 * each), runs through session.startArchitect / cancelArchitect.
 *
 * The creator's involvement is theirs to choose: one click builds the whole
 * game; or start the plan from the progression, shape any room, pin the ones
 * made by hand, pause after any stage to review, rebuild one room.
 */
export interface ArchitectProps {
  project: ProjectSpec;
  architect: ArchitectState;
  session: Session;
  locked: boolean;
  /** Show a built world room in the Rooms tab (App switches tabs); without it the button is hidden. */
  onOpenRoom?: (roomId: string) => void;
}

export function ArchitectMain(props: ArchitectProps) {
  return <PlanView {...props} />;
}

export function ArchitectSidebar({ project, architect, session, locked, live, art }: ArchitectProps & { live?: LiveState; art?: ArtState }) {
  return (
    <>
      {live && <RoomsLive live={live} project={project} />}
      <RunPanel project={project} architect={architect} session={session} locked={locked} art={art} />
    </>
  );
}
