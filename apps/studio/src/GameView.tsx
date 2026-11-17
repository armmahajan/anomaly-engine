import type { ArtState, ChangeResult, ProjectSpec } from "@anomaly/core";
import type { Session } from "./session.ts";
import { HandlerEditor } from "./HandlerEditor.tsx";
import { GameArtSection } from "./GameArtSection.tsx";
import { CheckSection } from "./CheckSection.tsx";
import { ItemsPanel } from "./ItemsPanel.tsx";
import { ModalsPanel } from "./ModalsPanel.tsx";
import { MapSettings } from "./MapSettings.tsx";

/**
 * Game mode's sidebar: what belongs to the whole game rather than one room.
 * The rules (presets of handlers), the world's own handlers, items, modals
 * and the map, and the art for all of it. The runtime shows the playtest room meanwhile.
 */
export function GamePanel({ project, session, art, locked }: { project: ProjectSpec; session: Session; art: ArtState; locked: boolean }) {
  const { rules } = project.world;
  const edit = async (op: string, input: unknown) => {
    const result: ChangeResult = await session.applyOperation(op, input);
    if (!result.ok) session.reportProblem(result.error.message);
    return result.ok;
  };
  return (
    <section className="game-panel" data-testid="game-panel">
      <h2>Game</h2>
      <CheckSection project={project} />
      <GameArtSection project={project} session={session} art={art} locked={locked} />
      <h3>Rules</h3>
      <p className="hint">Presets: each choice is a few handlers on top of the ones below.</p>
      <div className="field">
        <label htmlFor="rule-death">On death, back to</label>
        <select id="rule-death" value={rules.onDeath} disabled={locked} onChange={(e) => void edit("setGameRules", { onDeath: e.target.value })}>
          <option value="room">where you entered the room</option>
          <option value="start">the start</option>
          <option value="checkpoint">the last checkpoint</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="rule-save">Saving</label>
        <select id="rule-save" value={rules.save} disabled={locked} onChange={(e) => void edit("setGameRules", { save: e.target.value })}>
          <option value="room">on entering each room</option>
          <option value="never">never</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="rule-hazard">Hazard damage</label>
        <input
          id="rule-hazard"
          type="number"
          key={rules.hazardDamage}
          defaultValue={rules.hazardDamage}
          disabled={locked}
          onKeyDown={(e) => e.key === "Enter" && void edit("setGameRules", { hazardDamage: Number(e.currentTarget.value) })}
        />
      </div>

      <h3>Game handlers</h3>
      <p className="hint">On an event anywhere in the game, when the conditions hold, run the effects.</p>
      <HandlerEditor handlers={project.world.handlers} scope="world" project={project} locked={locked} label="world" onChange={(handlers) => void edit("setHandlers", { handlers })} />

      <ItemsPanel project={project} session={session} locked={locked} />
      <ModalsPanel project={project} session={session} locked={locked} />
      <MapSettings project={project} session={session} locked={locked} />
    </section>
  );
}
