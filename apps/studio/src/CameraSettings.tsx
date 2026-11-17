import type { ProjectSpec } from "@anomaly/core";
import type { Session } from "./session.ts";

/** Game tab: the play camera's zoom, as how many tiles tall the view is. */
export function CameraSettings({ project, session, locked }: { project: ProjectSpec; session: Session; locked: boolean }) {
  const rows = project.world.camera.rows;
  const set = async (value: number) => {
    if (!Number.isFinite(value) || value === rows) return;
    const result = await session.applyOperation("setCamera", { rows: value });
    if (!result.ok) session.reportProblem(result.error.message);
  };
  return (
    <div className="camera-settings">
      <h3>Camera</h3>
      <div className="field">
        <label htmlFor="camera-rows">View height (tiles)</label>
        <input
          id="camera-rows"
          type="number"
          min={6}
          max={40}
          key={rows}
          defaultValue={rows}
          disabled={locked}
          onKeyDown={(e) => e.key === "Enter" && void set(Number(e.currentTarget.value))}
          onBlur={(e) => void set(Number(e.currentTarget.value))}
        />
      </div>
      <p className="hint">The camera follows the player through rooms bigger than this, with parallax; smaller rooms are centred.</p>
    </div>
  );
}
