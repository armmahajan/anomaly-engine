import { useState } from "react";
import type { ChangeResult, ProjectSpec } from "@anomaly/core";
import type { Session } from "./session.ts";
import { ArtJobButton } from "./ArtJobButton.tsx";
import { fileUrl } from "./api.ts";

/** Game tab: the game's items (counted things the player carries): create, rename, recolor, describe, delete. */
export function ItemsPanel({ project, session, locked }: { project: ProjectSpec; session: Session; locked: boolean }) {
  const [name, setName] = useState("");
  const edit = async (op: string, input: unknown) => {
    const result: ChangeResult = await session.applyOperation(op, input);
    if (!result.ok) session.reportProblem(result.error.message);
    return result.ok;
  };
  const create = async () => {
    if (name.trim() && (await edit("createItem", { name: name.trim() }))) setName("");
  };
  return (
    <>
      <p className="hint">Things the player carries, counted. Handlers give and take them; conditions check them.</p>
      {project.world.items.length > 0 && (
        <div className="art-actions">
          <ArtJobButton
            session={session}
            request={{ stage: "itemArt" }}
            label={`🎨 Draw icons (${project.world.items.filter((i) => !i.icon).length})`}
            cost="$0.005 per 9 items: one sheet cut into icons"
            locked={locked}
            nothing={project.world.items.every((i) => i.icon) ? "Every item has an icon" : undefined}
          />
        </div>
      )}
      {project.world.items.map((item) => (
        <div key={item.id} className="item-row" data-testid={`item-${item.id}`}>
          <div className="spawn">
            {item.icon && <img className="item-icon" src={fileUrl(item.icon)} alt="" data-testid={`item-icon-${item.id}`} />}
            <input type="color" aria-label={`${item.id} color`} value={item.color} disabled={locked} onChange={(e) => void edit("updateItem", { itemId: item.id, changes: { color: e.target.value } })} />
            <input
              key={item.name}
              className="art-text item-name"
              aria-label={`${item.id} name`}
              defaultValue={item.name}
              disabled={locked}
              onBlur={(e) => e.currentTarget.value.trim() && e.currentTarget.value !== item.name && void edit("updateItem", { itemId: item.id, changes: { name: e.currentTarget.value.trim() } })}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            />
            <span className="spawn-id">{item.id}</span>
            <button type="button" className="icon-button" aria-label={`delete ${item.id}`} disabled={locked} onClick={() => void edit("deleteItem", { itemId: item.id })}>
              ✕
            </button>
          </div>
          <textarea
            key={item.description}
            className="art-text"
            aria-label={`${item.id} description`}
            placeholder="Description"
            rows={2}
            defaultValue={item.description}
            disabled={locked}
            onBlur={(e) => e.currentTarget.value !== item.description && void edit("updateItem", { itemId: item.id, changes: { description: e.currentTarget.value } })}
          />
        </div>
      ))}
      <div className="list-actions items-add">
        <input className="art-text" aria-label="new item name" placeholder="New item name" value={name} disabled={locked} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void create()} />
        <button type="button" disabled={locked || !name.trim()} onClick={() => void create()}>
          + Item
        </button>
      </div>
    </>
  );
}
