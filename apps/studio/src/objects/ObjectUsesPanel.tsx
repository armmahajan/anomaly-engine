import { useState } from "react";
import { objectUses, type ProjectSpec } from "@anomaly/core";
import type { Session } from "../session.ts";
import { askConfirm } from "../ui/confirm.tsx";

/**
 * An object's art panel, at the top: where the game uses it (props drawn with it, spawnEffect effects,
 * projectile looks; core objectUses) and Delete, which the project refuses while anything uses it
 * (the refusal is shown here).
 */
export function ObjectUsesPanel({ objectId, project, session, locked }: { objectId: string; project: ProjectSpec; session: Session; locked: boolean }) {
  const uses = objectUses(project).filter((u) => u.object === objectId);
  const [refused, setRefused] = useState<string | null>(null);

  const remove = async () => {
    setRefused(null);
    // In use: the operation refuses and says what uses it (nothing changes, so no question first).
    if (uses.length === 0 && !(await askConfirm({ title: `Delete the object ${objectId}?`, message: "Its art and clips go with it. Undo can restore it.", confirmLabel: "Delete", danger: true }))) return;
    const result = await session.applyOperation("deleteAsset", { assetId: objectId });
    if (!result.ok) setRefused(result.error.message);
  };

  return (
    <div className="object-uses" data-testid="object-uses">
      <span className="anim-caption">Used by</span>
      {uses.length === 0 ? (
        <span className="muted">nothing yet: give a prop this art, spawn it with spawnEffect, or fly it as a projectile</span>
      ) : (
        <ul>
          {uses.map((u) => (
            <li key={u.path} data-testid="object-use">
              {u.what}
              {u.clips.length > 0 && <span className="muted"> · {u.clips.join(", ")}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="art-actions">
        <button type="button" disabled={locked} onClick={() => void remove()}>
          Delete object
        </button>
      </div>
      {refused && (
        <p className="field-error" role="alert" data-testid="object-delete-refused">
          {refused}
        </p>
      )}
    </div>
  );
}
