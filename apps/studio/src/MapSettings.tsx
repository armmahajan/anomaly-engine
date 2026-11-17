import type { ProjectSpec } from "@anomaly/core";
import type { Session } from "./session.ts";

/** Game tab: the optional map screen: on / off. */
export function MapSettings({ project, session, locked }: { project: ProjectSpec; session: Session; locked: boolean }) {
  const set = async (enabled: boolean) => {
    const result = await session.applyOperation("setMap", { enabled });
    if (!result.ok) session.reportProblem(result.error.message);
  };
  return (
    <div className="map-settings">
      <h3>Map</h3>
      <label className="field-check">
        <input type="checkbox" checked={project.world.map.enabled} disabled={locked} onChange={(e) => void set(e.target.checked)} />
        Map screen (M / Tab)
      </label>
      <p className="hint">Shows the rooms the player has visited, plus those revealed by revealMap. The game pauses while it is open.</p>
    </div>
  );
}
