import { useState } from "react";
import type { ProjectSpec, RoomSpawn, WorldRoom } from "@anomaly/core";
import type { Session } from "./session.ts";
import { ConditionField, HandlerEditor } from "./HandlerEditor.tsx";

/** Rooms sidebar, under each enemy spawn: its health bar, when it spawns, and its handlers (e.g. what its death does). */
export function SpawnDetails({ project, session, room, spawn, locked }: { project: ProjectSpec; session: Session; room: WorldRoom; spawn: RoomSpawn; locked: boolean }) {
  const character = project.characters.find((c) => c.id === spawn.characterId);
  const [title, setTitle] = useState(spawn.healthBar?.title ?? character?.name ?? spawn.id);
  const edit = async (op: string, input: unknown) => {
    const result = await session.applyOperation(op, { roomId: room.id, spawnId: spawn.id, ...(input as object) });
    if (!result.ok) session.reportProblem(result.error.message);
  };
  const setBar = (on: boolean, text = title) => void edit("setSpawnHealthBar", { healthBar: on ? { title: text.trim() || spawn.id } : null });
  const open = spawn.healthBar !== null || spawn.handlers.length > 0 || spawn.when !== null;
  return (
    <details className="spawn-details" open={open} data-testid={`spawn-details-${spawn.id}`}>
      <summary>Health bar, condition &amp; handlers</summary>
      <div className="spawn-bar">
        <label className="inline-check">
          <input type="checkbox" aria-label={`${spawn.id} health bar`} checked={spawn.healthBar !== null} disabled={locked} onChange={(e) => setBar(e.target.checked)} />
          Health bar
        </label>
        <input
          aria-label={`${spawn.id} health bar title`}
          value={title}
          maxLength={60}
          disabled={locked || spawn.healthBar === null}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => spawn.healthBar && title.trim() !== spawn.healthBar.title && setBar(true)}
          onKeyDown={(e) => e.key === "Enter" && setBar(true)}
        />
      </div>
      <div className="spawn-bar">
        <label className="inline-check">
          <input
            type="checkbox"
            aria-label={`${spawn.id} conditional`}
            checked={spawn.when !== null}
            disabled={locked}
            onChange={(e) => void edit("setSpawnCondition", { when: e.target.checked ? { type: "flag", flag: `${spawn.id}_beaten`, is: false } : null })}
          />
          Only while
        </label>
        {spawn.when && (
          <ConditionField value={spawn.when} project={project} room={room} locked={locked} label={`${spawn.id} when`} onChange={(when) => void edit("setSpawnCondition", { when })} />
        )}
      </div>
      <HandlerEditor
        handlers={spawn.handlers}
        scope="spawn"
        project={project}
        room={room}
        locked={locked}
        label={spawn.id}
        onChange={(handlers) => void edit("setHandlers", { handlers })}
      />
    </details>
  );
}
