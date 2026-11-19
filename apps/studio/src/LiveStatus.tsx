import { useEffect, useRef } from "react";
import type { ArtState, LiveState, ProjectSpec } from "@anomaly/core";
import type { Session } from "./session.ts";
import { usePopover } from "./ui/usePopover.ts";

/**
 * Auto-build, in the toolbar: what the studio is building by itself as the
 * creator designs (game characters from the wiki and their art, rooms from the
 * progression), whether its saves wait for a playtest, and the two switches.
 * None of it locks editing.
 */
export function LiveStatus({ project, art, live, session }: { project: ProjectSpec; art: ArtState; live: LiveState; session: Session }) {
  const { open, setOpen, ref } = usePopover();
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLElement>("input")?.focus();
  }, [open]);

  const name = (id: string) => project.characters.find((c) => c.id === id)?.name ?? id;
  const parts: string[] = [];
  if (live.cast.working.length) parts.push(live.cast.message || `making ${live.cast.working.map(name).join(", ")}`);
  if (live.rooms.status !== "idle") parts.push(live.rooms.message || "building rooms…");
  const weapon = (id: string) => project.weapons.list.find((w) => w.id === id)?.name ?? id;
  // Every background art job running (several run at once when they touch different things).
  for (const job of art.runningJobs.filter((j) => !j.underLock)) {
    parts.push(`drawing ${job.characterId ? name(job.characterId) : job.weaponId ? weapon(job.weaponId) : (job.biomeId ?? (job.stage === "worldKit" ? "a world" : job.stage))} (${job.stage}${job.waiting ? ", waiting" : ""})`);
  }
  if (art.queued > 0) parts.push(`${art.queued} art job${art.queued > 1 ? "s" : ""} queued`);
  const busy = parts.length > 0;
  const on = live.settings.cast || live.settings.rooms;
  const problem = live.cast.error ?? live.rooms.error;
  const label = busy ? `⟳ ${parts.join(" · ")}` : on ? "Auto-build on" : "Auto-build off";

  return (
    <div className={`live-status${busy ? " busy" : ""}${on ? " on" : ""}${problem ? " failed" : ""}`} data-testid="live-status" ref={ref}>
      <button
        type="button"
        className="live-summary"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Auto-build: what the studio builds by itself as you design"
        onClick={() => setOpen(!open)}
      >
        {label}
        {live.waiting && busy && <span className="live-waiting"> · saves wait: {live.waiting}</span>}
        <span className="caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="menu live-menu" role="dialog" aria-label="Auto-build" ref={panelRef}>
          <h2>Auto-build</h2>
          <p className="menu-note">As you and the director design, the studio can build the game in the background. It never locks editing.</p>
          <label className="live-switch">
            <input type="checkbox" aria-label="live cast" checked={live.settings.cast} onChange={(e) => void session.setLive({ cast: e.target.checked })} />
            <span>
              Characters from the wiki
              <small>Character pages marked in the game (player or enemy) become game characters, with a behavior and art.</small>
            </span>
          </label>
          <label className="live-switch">
            <input type="checkbox" aria-label="live rooms" checked={live.settings.rooms} onChange={(e) => void session.setLive({ rooms: e.target.checked })} />
            <span>
              Rooms from the progression
              <small>Regions become rooms (tiles and doors, no art) until you or the Architect take over the plan.</small>
            </span>
          </label>
          <h3>Now</h3>
          {busy ? (
            <ul className="live-now">
              {parts.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          ) : (
            <p className="menu-note">Nothing running.</p>
          )}
          {live.waiting && <p className="menu-note">Saves wait while {live.waiting}.</p>}
          {live.cast.message && !live.cast.working.length && <p className="menu-note">From the wiki: {live.cast.message}</p>}
          {live.rooms.message && live.rooms.status === "idle" && <p className="menu-note">Rooms: {live.rooms.message}</p>}
          {problem && <p className="field-error">{problem}</p>}
        </div>
      )}
    </div>
  );
}

/** A character's background work, for its row in the character list. */
export function characterWork(id: string, art: ArtState, live: LiveState): string | null {
  if (live.cast.working.includes(id)) return "writing behavior";
  const job = art.runningJobs.find((j) => j.characterId === id);
  if (job) return `drawing · ${job.stage}${job.waiting ? " (waiting)" : ""}`;
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
