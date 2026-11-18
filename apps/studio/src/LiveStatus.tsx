import type { ArtState, LiveState, ProjectSpec } from "@anomaly/core";
import type { Session } from "./session.ts";

/**
 * Background work, in the toolbar: what the studio is filling in by itself (game
 * characters from the wiki and their art, rooms from the progression), whether its
 * saves wait for a playtest, and the switches for the live cast and rooms. None of it
 * locks editing.
 */
export function LiveStatus({ project, art, live, session }: { project: ProjectSpec; art: ArtState; live: LiveState; session: Session }) {
  const name = (id: string) => project.characters.find((c) => c.id === id)?.name ?? id;
  const parts: string[] = [];
  if (live.cast.working.length) parts.push(live.cast.message || `making ${live.cast.working.map(name).join(", ")}`);
  if (live.rooms.status !== "idle") parts.push(live.rooms.message || "building rooms…");
  const job = art.running && !art.running.underLock ? art.running : null;
  if (job) parts.push(`drawing ${job.characterId ? name(job.characterId) : (job.biomeId ?? "a world")} (${job.stage})`);
  if (art.queued > 0) parts.push(`${art.queued} art job${art.queued > 1 ? "s" : ""} queued`);
  const waiting = live.waiting && parts.length ? ` · saves wait: ${live.waiting}` : "";
  const busy = parts.length > 0;
  const problem = live.cast.error ?? live.rooms.error;
  return (
    <details className={`live-status${busy ? " busy" : ""}`} data-testid="live-status">
      <summary title="Work the studio does in the background as you design">
        {busy ? `⟳ ${parts.join(" · ")}${waiting}` : live.settings.cast || live.settings.rooms ? "Live ✓" : "Live off"}
      </summary>
      <div className="live-menu">
        <label title="Character pages the director or you write (in_game: player or enemy) become game characters with a behavior and art">
          <input type="checkbox" aria-label="live cast" checked={live.settings.cast} onChange={(e) => void session.setLive({ cast: e.target.checked })} /> Characters from the wiki
        </label>
        <label title="The progression's regions become rooms (no model, no art) until you or the Architect take over the plan">
          <input type="checkbox" aria-label="live rooms" checked={live.settings.rooms} onChange={(e) => void session.setLive({ rooms: e.target.checked })} /> Rooms from the progression
        </label>
        {live.cast.message && !live.cast.working.length && <p className="hint">Cast: {live.cast.message}</p>}
        {live.rooms.message && live.rooms.status === "idle" && <p className="hint">Rooms: {live.rooms.message}</p>}
        {problem && <p className="field-error">{problem}</p>}
      </div>
    </details>
  );
}

/** A character's background work, for its row in the character list. */
export function characterWork(id: string, art: ArtState, live: LiveState): string | null {
  if (live.cast.working.includes(id)) return "writing behavior";
  if (art.running?.characterId === id) return `drawing · ${art.running.stage}${art.running.waiting ? " (waiting)" : ""}`;
  if (art.pending.some((p) => p.characterId === id)) return "art queued";
  return null;
}

/** The live rooms' line for the Rooms and Architect sidebars. */
export function RoomsLive({ live }: { live: LiveState }) {
  if (!live.settings.rooms && live.rooms.status === "idle") return null;
  const text =
    live.rooms.status === "building"
      ? live.rooms.message || "building rooms from the progression…"
      : live.rooms.status === "saving"
        ? `saving the rooms${live.waiting ? ` (waiting: ${live.waiting})` : "…"}`
        : live.rooms.message;
  if (!text && !live.rooms.error) return null;
  return (
    <p className={`hint rooms-live${live.rooms.status !== "idle" ? " busy" : ""}`} data-testid="rooms-live">
      {live.rooms.status !== "idle" ? "⟳ " : ""}
      {text}
      {live.rooms.error && <span className="field-error"> {live.rooms.error}</span>}
    </p>
  );
}
