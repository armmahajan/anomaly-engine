import type { ProjectSpec, WorldRoom } from "@anomaly/core";
import type { Session } from "./session.ts";

/** A stable, distinct color per progression region (by its place in the list), for the world map. */
export function regionColor(project: ProjectSpec, regionId: string | undefined): string | undefined {
  const i = project.progression.regions.findIndex((r) => r.id === regionId);
  return i < 0 ? undefined : `hsl(${(i * 137.5 + 200) % 360} 45% 32%)`;
}

/** Rooms sidebar: which progression region the selected room belongs to. */
export function RegionPicker({ project, session, room, locked }: { project: ProjectSpec; session: Session; room: WorldRoom; locked: boolean }) {
  const { regions } = project.progression;
  const region = regions.find((r) => r.id === room.regionId);
  const count = region ? project.world.rooms.filter((r) => r.regionId === region.id).length : 0;
  const setRegion = async (regionId: string) => {
    const result = await session.applyOperation("updateWorldRoom", { roomId: room.id, changes: { regionId: regionId || null } });
    if (!result.ok) session.reportProblem(result.error.message);
  };
  return (
    <div className="field region-picker" data-testid="region-picker">
      <label htmlFor="room-region">
        Region <span className="region-swatch" style={{ background: regionColor(project, room.regionId) ?? "transparent" }} />
      </label>
      {regions.length === 0 ? (
        <span className="hint">No regions yet: plan them in Progression.</span>
      ) : (
        <>
          <select id="room-region" aria-label="room region" value={room.regionId ?? ""} disabled={locked} onChange={(e) => void setRegion(e.target.value)}>
            <option value="">— none —</option>
            {regions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          {region && (
            <span className="hint">
              {count} of {region.rooms} planned room{region.rooms === 1 ? "" : "s"}
            </span>
          )}
        </>
      )}
    </div>
  );
}
