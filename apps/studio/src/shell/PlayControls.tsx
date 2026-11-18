import { useEffect, useRef } from "react";
import type { ProjectSpec, WorldStart } from "@anomaly/core";
import { usePopover } from "../ui/usePopover.ts";

/**
 * ▶ Play, what it plays, ■ Stop, the replay seed and the runtime's status.
 * ▶ Play tests the playtest room (with its abilities); the chip beside it says
 * which room and offers the other way in: the game from its real start.
 */
export function PlayControls({
  project,
  playing,
  canPlay,
  seed,
  status,
  statusClass,
  onPlay,
  onStop,
  onPlayFromStart,
  onOpenRoom,
}: {
  project: ProjectSpec;
  playing: boolean;
  canPlay: boolean;
  seed: number | null;
  /** "Editing", "Playing", "Loading game…", "AI is editing…" (the e2e helpers read it). */
  status: string;
  statusClass: string;
  onPlay: (seed?: number) => void;
  onStop: () => void;
  onPlayFromStart: (start: WorldStart) => void;
  onOpenRoom: (roomId: string) => void;
}) {
  const { open, setOpen, ref } = usePopover();
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }, [open]);

  const { playtest, start, rooms } = project.world;
  const testRoom = rooms.find((r) => r.id === playtest?.room) ?? null;
  const startRoom = rooms.find((r) => r.id === start?.room) ?? null;
  const abilities = playtest?.abilities ?? [];
  const abilityText = abilities.length ? abilities.map((a) => a.replace(/_/g, " ")).join(", ") : "no abilities";
  const target = testRoom ? testRoom.name : "no playtest room";
  const playHint = testRoom
    ? `Play the playtest room, ${testRoom.name} (${abilityText}); doors lead on into the rest of the world`
    : "Set a playtest room in Rooms first";

  return (
    <div className="play-controls" ref={ref}>
      <button type="button" className="play-button" onClick={() => onPlay()} disabled={!canPlay} title={playHint}>
        ▶ Play
      </button>
      <button type="button" onClick={onStop} disabled={!playing}>
        ■ Stop
      </button>
      {seed !== null && (
        <button
          type="button"
          className="seed-button"
          onClick={() => onPlay(seed)}
          disabled={!canPlay}
          aria-label={`⟲ Seed ${seed}`}
          title={`Play again with the same random choices (seed ${seed})`}
        >
          ⟲
        </button>
      )}
      <button
        type="button"
        className={`play-target${testRoom ? "" : " missing"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`What Play tests: ${target}`}
        title="What Play tests"
        onClick={() => setOpen(!open)}
      >
        <small>tests</small> <span className="play-target-name">{target}</span>
        <span className="caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="menu play-target-panel" role="dialog" aria-label="What Play tests" ref={panelRef}>
          <h2>▶ Play tests the playtest room</h2>
          {testRoom ? (
            <p>
              <b>{testRoom.name}</b>, from the playtest spot, with {abilityText}. Doors lead on into the rest of the world.
            </p>
          ) : (
            <p>There is no playtest room yet: pick a room in Rooms and press “Playtest here”.</p>
          )}
          <div className="menu-actions">
            {start && startRoom && (
              <button
                type="button"
                disabled={!canPlay}
                title="A fresh run from the game's start, with no abilities, in Rooms"
                onClick={() => {
                  setOpen(false);
                  onPlayFromStart({ room: start.room, x: start.x, y: start.y, abilities: [] });
                }}
              >
                Play the game from its start <small>({startRoom.name})</small>
              </button>
            )}
            {testRoom && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onOpenRoom(testRoom.id);
                }}
              >
                Change it in Rooms
              </button>
            )}
          </div>
        </div>
      )}
      <span className={`status ${statusClass}`} data-testid="runtime-status" aria-live="polite">
        {status}
      </span>
    </div>
  );
}
