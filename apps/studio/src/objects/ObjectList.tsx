import { useState } from "react";
import { objectAssets, objectUses, type ArtState, type ProjectSpec } from "@anomaly/core";
import type { Session } from "../session.ts";
import { fileUrl } from "../api.ts";
import { ListSection } from "../ui/ListSection.tsx";
import { newObjectCall } from "./objectRefs.ts";
import "./objects.css";

/**
 * Characters tab sidebar: the Objects group. Objects are animated things that aren't game characters
 * (a lever, a trap, an effect, a projectile): props draw with them, spawnEffect shows them, projectile
 * looks fly as them. Selecting one opens the same workbench as a character; + Object makes one from a
 * name and a brief (createObject), ready to draw.
 */
export function ObjectList({ project, art, session, selectedId, onSelect, locked }: {
  project: ProjectSpec;
  art: ArtState;
  session: Session;
  selectedId: string | null;
  onSelect: (id: string) => void;
  locked: boolean;
}) {
  const objects = objectAssets(project);
  const uses = objectUses(project);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [brief, setBrief] = useState("");

  const create = async () => {
    if (!name.trim()) return;
    const call = newObjectCall(project, name, brief);
    const result = await session.applyOperation(call.name, call.input);
    if (!result.ok) return session.reportProblem(result.error.message);
    setAdding(false);
    setName("");
    setBrief("");
    onSelect(call.input.id);
  };

  return (
    <ListSection id="objects" title="Objects" count={objects.length} testId="object-list" hint={objects.length === 0 ? "Animated things that aren't characters: levers, traps, effects, projectiles." : undefined}>
      <ul className="character-list">
        {objects.map((o) => {
          const working = art.runningJobs.some((j) => j.objectId === o.id);
          const used = uses.filter((u) => u.object === o.id).length;
          return (
            <li key={o.id}>
              <button
                type="button"
                data-testid={`object-${o.id}`}
                className={o.id === selectedId ? "selected" : ""}
                aria-current={o.id === selectedId ? "true" : undefined}
                onClick={() => onSelect(o.id)}
              >
                {o.preview ? <img className="swatch-img" src={fileUrl(o.preview.file)} alt="" /> : <span className="swatch object-swatch" />}
                <span className="item-name">{o.name}</span>
                {working && <span className="tag work">drawing</span>}
                <span className="kind" title={used ? `used in ${used} place${used > 1 ? "s" : ""}` : "not used yet"}>
                  {Object.keys(o.clips).length} clips{used ? ` · ${used} use${used > 1 ? "s" : ""}` : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {adding ? (
        <form
          className="object-new"
          data-testid="new-object"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input className="art-text" aria-label="object name" placeholder="Name (e.g. Floor lever)" value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} />
          <textarea
            className="art-text"
            aria-label="object brief"
            rows={2}
            maxLength={2000}
            placeholder="What it is and looks like (e.g. a rusted floor lever with a red knob)"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
          />
          <div className="list-actions">
            <button type="submit" disabled={locked || !name.trim()}>
              Create
            </button>
            <button type="button" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="list-actions">
          <button type="button" disabled={locked} onClick={() => setAdding(true)}>
            + Object
          </button>
        </div>
      )}
    </ListSection>
  );
}
