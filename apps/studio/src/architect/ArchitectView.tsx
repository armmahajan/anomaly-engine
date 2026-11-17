import type { ArchitectState, ProjectSpec } from "@anomaly/core";
import type { Session } from "../session.ts";

/**
 * The Architect tab (agent N owns this folder): the plan as an editable document
 * (game guidance, region notes, room cards, links, pins, pause-after toggles) and
 * the run's stage progress. Edits go through the plan operations
 * (session.applyOperation), runs through session.startArchitect / cancelArchitect.
 */
export interface ArchitectProps {
  project: ProjectSpec;
  architect: ArchitectState;
  session: Session;
  locked: boolean;
}

export function ArchitectMain({ project }: ArchitectProps) {
  return (
    <div className="architect-main" data-testid="architect-main">
      <h2>Architect</h2>
      <p>{project.architect.rooms.length} planned rooms.</p>
    </div>
  );
}

export function ArchitectSidebar({ architect, session, locked }: ArchitectProps) {
  return (
    <section data-testid="architect-sidebar">
      <h2>Build game</h2>
      <button type="button" disabled={locked || architect.running !== null} onClick={() => void session.startArchitect({})}>
        Build game
      </button>
    </section>
  );
}
