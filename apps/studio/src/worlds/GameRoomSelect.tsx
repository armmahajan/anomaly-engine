import type { ProjectSpec } from "@anomaly/core";
import { regionGroups, roomArt } from "./scenery.ts";

/**
 * A game room picker for scenery: rooms grouped by region, each marked with
 * the scenery it has now (so replacing one is never a surprise).
 */
export function GameRoomSelect({
  project,
  value,
  onChange,
  none,
  label,
  disabled,
  ownLook,
  ownDressing,
}: {
  project: ProjectSpec;
  value: string;
  onChange: (roomId: string) => void;
  /** The text of the empty choice. */
  none: string;
  label: string;
  disabled?: boolean;
  /** The dressing being edited: rooms it dresses aren't marked as dressed by something else. */
  ownLook?: string;
  ownDressing?: string;
}) {
  const mark = (room: ProjectSpec["world"]["rooms"][number]) => {
    const art = roomArt(project, room);
    if (art.state === "plain") return "";
    if (room.dressing?.biome === ownLook && room.dressing?.room === ownDressing) return "";
    return ` (dressed: ${art.dressing?.name ?? "?"})`;
  };
  return (
    <select className="game-room-select" aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">{none}</option>
      {regionGroups(project).map((g) => (
        <optgroup key={g.id} label={g.name}>
          {g.rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
              {mark(r)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
