import type { KeyboardEvent } from "react";

export interface TabGroup<T extends string> {
  /** Shown small above the group, e.g. "Design". */
  label: string;
  tabs: readonly T[];
}

/**
 * The studio's tabs in the creator's order, grouped (design → build → play).
 * A tablist with manual activation: ←/→ (and Home/End) move between tabs, Enter
 * or Space opens one (opening a tab can stop a playtest, so arrows never do).
 */
export function StudioTabs<T extends string>({
  groups,
  labels,
  hints,
  counts,
  countHint,
  active,
  onOpen,
}: {
  groups: readonly TabGroup<T>[];
  labels: Record<T, string>;
  hints: Partial<Record<T, string>>;
  /** A badge per tab (e.g. drafts awaiting review); 0 hides it. */
  counts: Partial<Record<T, number>>;
  countHint?: string;
  active: T;
  onOpen: (tab: T) => void;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const tabs = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const next =
      e.key === "ArrowRight" ? (at + 1) % tabs.length
      : e.key === "ArrowLeft" ? (at - 1 + tabs.length) % tabs.length
      : e.key === "Home" ? 0
      : e.key === "End" ? tabs.length - 1
      : null;
    if (next === null) return;
    e.preventDefault();
    tabs[next]!.focus();
  };

  return (
    <nav className="tabs" role="tablist" aria-label="Studio" onKeyDown={onKeyDown}>
      {groups.map((group) => (
        <div key={group.label} className="tab-group" role="presentation" data-group={group.label.toLowerCase()}>
          <span className="tab-group-label" aria-hidden="true">
            {group.label}
          </span>
          <div className="tab-group-tabs" role="presentation">
            {group.tabs.map((t) => {
              const count = counts[t] ?? 0;
              return (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={active === t}
                  tabIndex={active === t ? 0 : -1}
                  className={active === t ? "selected" : ""}
                  title={hints[t]}
                  data-tab={t}
                  onClick={() => onOpen(t)}
                >
                  {labels[t]}
                  {count > 0 && (
                    <span className="tab-count" title={countHint}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
