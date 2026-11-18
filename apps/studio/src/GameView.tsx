import { keysText, type ArtState, type ChangeResult, type ProjectSpec } from "@anomaly/core";
import type { Session } from "./session.ts";
import { HandlerEditor } from "./HandlerEditor.tsx";
import { GameArtSection, GameArtSummary } from "./GameArtSection.tsx";
import { CheckSection } from "./CheckSection.tsx";
import { ItemsPanel } from "./ItemsPanel.tsx";
import { ModalsPanel } from "./ModalsPanel.tsx";
import { MapSettings } from "./MapSettings.tsx";
import { CameraSettings } from "./CameraSettings.tsx";
import { ControlsSettings } from "./ControlsSettings.tsx";
import { GameSection } from "./content/GameSection.tsx";
import { WeaponsPanel } from "./weapons/WeaponsPanel.tsx";
import { LoadoutPanel, loadoutSummary } from "./weapons/LoadoutPanel.tsx";

/**
 * Game mode: what belongs to the whole game rather than one room. The sidebar
 * (GamePanel) holds the whole-game actions, checking the game and drawing its
 * art; under the stage (GameSettings) are its settings: the rules (presets of
 * handlers), the world's own handlers, items, modals (previewed on the stage
 * above), the map and the camera. The runtime shows the playtest room meanwhile.
 */
export function GamePanel({ project, session, art, locked }: { project: ProjectSpec; session: Session; art: ArtState; locked: boolean }) {
  return (
    <section className="game-panel game-overview" data-testid="game-overview">
      <h2>Game</h2>
      <p className="hint game-panel-intro">What belongs to the whole game rather than one room. Its settings are under the stage.</p>
      <GameSection id="check" title="Check the game" summary="beatable, no dead ends?">
        <CheckSection project={project} />
      </GameSection>
      <GameSection id="art" title="Art" summary={<GameArtSummary project={project} />}>
        <GameArtSection project={project} session={session} art={art} locked={locked} />
      </GameSection>
    </section>
  );
}

export function GameSettings({ project, session, locked }: { project: ProjectSpec; session: Session; locked: boolean }) {
  const { rules } = project.world;
  const edit = async (op: string, input: unknown) => {
    const result: ChangeResult = await session.applyOperation(op, input);
    if (!result.ok) session.reportProblem(result.error.message);
    return result.ok;
  };
  const handlers = project.world.handlers.length;
  const { items, modals } = project.world;
  const deathText = { room: "back to the room's entrance", start: "back to the start", checkpoint: "back to the last checkpoint" }[rules.onDeath];
  return (
    <section className="game-panel game-settings" data-testid="game-panel">
      <h2>Game settings</h2>
      <div className="game-settings-grid">
        <GameSection id="rules" title="Rules" summary={`death: ${rules.onDeath} · save: ${rules.save === "room" ? "each room" : "never"}`}>
          <p className="hint">Presets: each choice is a few handlers on top of the game handlers below.</p>
          <div className="field">
            <label htmlFor="rule-death">On death, back to</label>
            <select id="rule-death" value={rules.onDeath} disabled={locked} onChange={(e) => void edit("setGameRules", { onDeath: e.target.value })}>
              <option value="room">where you entered the room</option>
              <option value="start">the start</option>
              <option value="checkpoint">the last checkpoint</option>
            </select>
            <p className="hint field-note">On death the player goes {deathText}.</p>
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
            <div className="field-input">
              <input
                id="rule-hazard"
                type="number"
                min={0}
                key={rules.hazardDamage}
                defaultValue={rules.hazardDamage}
                disabled={locked}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                onBlur={(e) => {
                  const value = Number(e.currentTarget.value);
                  if (Number.isFinite(value) && value !== rules.hazardDamage) void edit("setGameRules", { hazardDamage: value });
                }}
              />
              <span className="unit">HP</span>
            </div>
          </div>
        </GameSection>
        <GameSection id="handlers" title="Game handlers" summary={handlers ? `${handlers} handler${handlers === 1 ? "" : "s"}` : "none"}>
          <p className="hint">On an event anywhere in the game, when the conditions hold, run the effects.</p>
          <HandlerEditor handlers={project.world.handlers} scope="world" project={project} locked={locked} label="world" onChange={(handlers) => void edit("setHandlers", { handlers })} />
        </GameSection>
        <GameSection id="items" title="Items" summary={items.length ? `${items.length} item${items.length === 1 ? "" : "s"}` : "none"}>
          <ItemsPanel project={project} session={session} locked={locked} />
        </GameSection>
        <GameSection id="loadout" title="Loadout" summary={loadoutSummary(project)}>
          <LoadoutPanel project={project} session={session} locked={locked} />
        </GameSection>
        <GameSection id="weapons" title="Weapons" summary={project.weapons.list.length ? project.weapons.list.map((w) => w.name).join(", ") : "none"} wide>
          <WeaponsPanel project={project} session={session} locked={locked} />
        </GameSection>
        <GameSection id="modals" title="Modals" summary={modals.length ? `${modals.length} screen${modals.length === 1 ? "" : "s"}` : "none"}>
          <ModalsPanel project={project} session={session} locked={locked} />
        </GameSection>
        <GameSection id="map" title="Map" summary={project.world.map.enabled ? "on" : "off"}>
          <MapSettings project={project} session={session} locked={locked} />
        </GameSection>
        <GameSection id="camera" title="Camera" summary={`${project.world.camera.rows} tiles tall`}>
          <CameraSettings project={project} session={session} locked={locked} />
        </GameSection>
        <GameSection id="controls" title="Controls" summary={`jump ${keysText(project.controls.bindings.jump)} · attack ${keysText(project.controls.bindings.attack)}`}>
          <ControlsSettings project={project} session={session} locked={locked} />
        </GameSection>
      </div>
    </section>
  );
}
