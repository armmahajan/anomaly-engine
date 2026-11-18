import type { ProjectSpec, WorldRoom } from "@anomaly/core";
import type { Session } from "../session.ts";
import { lookForRoom, looksOf, roomArt } from "../worlds/scenery.ts";
import { ArtDot } from "./RoomList.tsx";

/** Open the Scenery tab on a look and dressing; `room` is the game room to dress there. */
export type OpenScenery = (target: { lookId: string | null; dressingId: string | null; room: string }) => void;

/**
 * Rooms sidebar: the selected room's scenery (its art, made in the Scenery
 * tab): which look and dressing draw it, whether its tiles changed since, and
 * the way to Scenery to dress or recompose it.
 */
export function RoomScenery({ project, session, room, locked, onOpenScenery }: { project: ProjectSpec; session: Session; room: WorldRoom; locked: boolean; onOpenScenery?: OpenScenery }) {
  const art = roomArt(project, room);
  const looks = looksOf(project);
  const undress = async () => {
    const result = await session.applyOperation("setDressing", { worldRoomId: room.id, biomeId: null });
    if (!result.ok) session.reportProblem(result.error.message);
  };

  if (art.state === "plain") {
    const look = lookForRoom(project, room);
    return (
      <div className="room-scenery" data-testid="room-scenery" data-art="plain">
        <p className="hint">
          <ArtDot state="plain" /> Plain tiles: no scenery yet.{" "}
          {looks.length === 0 ? "Paint a look (a region's art kit) in Scenery, then dress this room with it." : `Compose a dressing for it in Scenery${look ? ` from ${look.name}` : ""}.`}
        </p>
        {onOpenScenery && (
          <button type="button" onClick={() => onOpenScenery({ lookId: look?.id ?? null, dressingId: null, room: room.id })}>
            {looks.length === 0 ? "Open Scenery" : "Dress it in Scenery →"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="room-scenery" data-testid="room-scenery" data-art={art.state}>
      <p className="room-scenery-line">
        <ArtDot state={art.state} /> Dressed with <strong>{art.dressing?.name ?? "a deleted dressing"}</strong>
        {art.look && <span className="muted room-scenery-look">a dressing of the look {art.look.name}</span>}
      </p>
      {art.state === "stale" && <p className="hint warn">Its tiles or doors changed since it was dressed: recompose the dressing in Scenery to fit them.</p>}
      <div className="art-actions">
        {onOpenScenery && (
          <button type="button" onClick={() => onOpenScenery({ lookId: art.look?.id ?? null, dressingId: art.dressing?.id ?? null, room: room.id })}>
            {art.state === "stale" ? "Recompose in Scenery →" : "Open in Scenery →"}
          </button>
        )}
        <button type="button" disabled={locked} title="Draw this room as plain tiles (the dressing is kept in Scenery; Undo puts it back)" onClick={() => void undress()}>
          Use plain tiles
        </button>
      </div>
    </div>
  );
}
