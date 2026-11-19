import { objectAssets, type ProjectileLook, type ProjectSpec } from "@anomaly/core";
import { Cell, Num, Pick } from "../weapons/fields.tsx";
import { clipsOf } from "./objectRefs.ts";

/**
 * A projectile's look (weapon projectile attacks and the enemy shoot action): where it appears on the
 * shooter (origin, px from its centre facing right), when (at fire, or through the windup, charging
 * at its origin) and what it looks like (a coloured shape, or an object with charge, fly and burst
 * clips). Each pick hands the whole new look to `onChange` (one edit).
 */
export function ProjectileLookFields({ look, onChange, project, locked, label }: { look: ProjectileLook; onChange: (look: ProjectileLook) => void; project: ProjectSpec; locked: boolean; label: string }) {
  const objects = objectAssets(project);
  const art = look.art;
  const clips = clipsOf(project, art?.object);
  const clipOptions = (fallback: string, current: string | null) => [
    { id: "", label: fallback },
    ...[...new Set([...clips, ...(current ? [current] : [])])].map((c) => ({ id: c, label: clips.includes(c) ? c : `${c} (not drawn yet)` })),
  ];
  const setArt = (changes: Partial<NonNullable<ProjectileLook["art"]>>) => art && onChange({ ...look, art: { ...art, ...changes } });
  const clipPick = (name: "charge" | "fly" | "burst", fallback: string, title: string) =>
    art && (
      <Cell label={name[0]!.toUpperCase() + name.slice(1)} title={title}>
        <Pick label={`${label} look ${name}`} value={art[name] ?? ""} options={clipOptions(fallback, art[name])} disabled={locked} onPick={(c) => setArt({ [name]: c || null })} />
      </Cell>
    );
  return (
    <>
      <Cell label="Origin x" title="px ahead of the shooter's centre (facing right)">
        <span className="wpn-inline">
          <Num label={`${label} look origin x`} value={look.origin[0]} min={-1000} max={1000} disabled={locked} onCommit={(x) => onChange({ ...look, origin: [x, look.origin[1]] })} />
          <span className="unit">px</span>
        </span>
      </Cell>
      <Cell label="Origin y" title="px below the shooter's centre (negative = above)">
        <span className="wpn-inline">
          <Num label={`${label} look origin y`} value={look.origin[1]} min={-1000} max={1000} disabled={locked} onCommit={(y) => onChange({ ...look, origin: [look.origin[0], y] })} />
          <span className="unit">px</span>
        </span>
      </Cell>
      <Cell label="Appears" title="At fire, or at its origin through the windup (charging), then it flies">
        <Pick
          label={`${label} look appear`}
          value={look.appear}
          options={[
            { id: "fire", label: "when fired" },
            { id: "windup", label: "during the windup" },
          ]}
          disabled={locked}
          onPick={(appear) => onChange({ ...look, appear })}
        />
      </Cell>
      <Cell label="Art" title="An object (pointing right) drawn as the projectile, else a coloured shape">
        <Pick
          label={`${label} look object`}
          value={art?.object ?? ""}
          options={[
            { id: "", label: "(coloured shape)" },
            ...objects.map((o) => ({ id: o.id, label: o.name })),
            ...(art && !objects.some((o) => o.id === art.object) ? [{ id: art.object, label: `${art.object} (missing)` }] : []),
          ]}
          disabled={locked}
          onPick={(object) => {
            if (!object) return onChange({ ...look, art: null });
            const has = (c: string) => clipsOf(project, object).includes(c);
            onChange({ ...look, art: { object, charge: has("charge") ? "charge" : null, fly: has("fly") ? "fly" : null, burst: has("burst") ? "burst" : null } });
          }}
        />
      </Cell>
      {clipPick("charge", "(idle)", "Its clip while charging at its origin (appear during the windup)")}
      {clipPick("fly", "(idle)", "Its clip in flight")}
      {clipPick("burst", "(none)", "Played as an effect where it breaks")}
    </>
  );
}
