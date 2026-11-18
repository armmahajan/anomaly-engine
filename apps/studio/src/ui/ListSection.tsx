import { useId, useSyncExternalStore, type ReactNode } from "react";

/**
 * A titled, collapsible part of a side panel: a sticky header (title, count,
 * actions) over a body. Level 1 is a panel section ("Rooms"), level 2 a group
 * inside one ("The Underpass"); both headers stay in view while their body
 * scrolls under them. Whether each is open is remembered per browser by `id`.
 *
 *   <ListSection id="rooms:underpass" level={2} title="The Underpass" count={8} forceOpen={query !== ""}>
 *     <ul className="character-list">…</ul>
 *   </ListSection>
 */
export interface ListSectionProps {
  /** Stable id (e.g. "wiki:character"): the open/closed choice is remembered under it. */
  id: string;
  title: ReactNode;
  /** Shown beside the title, e.g. the number of items (or "3 of 45" while filtering). */
  count?: number | string;
  /** Buttons at the right of the header (they don't toggle the section). */
  actions?: ReactNode;
  /** 1: a panel section; 2: a group inside a section. */
  level?: 1 | 2;
  /** Open until the creator closes it (default true). */
  defaultOpen?: boolean;
  /** Show it open whatever the creator chose, e.g. while a filter is typed. */
  forceOpen?: boolean;
  /** A short line under the header (e.g. what the section is for). */
  hint?: ReactNode;
  className?: string;
  testId?: string;
  children: ReactNode;
}

export function ListSection({ id, title, count, actions, level = 1, defaultOpen = true, forceOpen = false, hint, className, testId, children }: ListSectionProps) {
  const [open, setOpen] = useOpen(id, defaultOpen);
  const bodyId = useId();
  const shown = forceOpen || open;
  const Heading = level === 1 ? "h2" : "h3";
  return (
    <section className={`list-section level-${level}${shown ? " open" : ""}${className ? ` ${className}` : ""}`} data-testid={testId} data-section={id}>
      <div className="list-section-head">
        <Heading className="list-section-heading">
          <button
            type="button"
            className="list-section-toggle"
            aria-expanded={shown}
            aria-controls={bodyId}
            title={forceOpen ? undefined : shown ? "Collapse" : "Expand"}
            onClick={() => !forceOpen && setOpen(!shown)}
          >
            <span className="list-chevron" aria-hidden="true" />
            <span className="list-section-title">{title}</span>
            {count !== undefined && <span className="list-count">{count}</span>}
          </button>
        </Heading>
        {actions && <div className="list-section-actions">{actions}</div>}
      </div>
      {shown && (
        <div id={bodyId} className="list-section-body">
          {hint && <p className="hint list-section-hint">{hint}</p>}
          {children}
        </div>
      )}
    </section>
  );
}

// --- remembered open/closed state (per browser; storage can fail, defaults always work) ---

const KEY = "anomaly.sections";
let openById: Record<string, boolean> = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
})();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Whether section `id` is open, and a setter; shared by every component showing that id. */
export function useOpen(id: string, defaultOpen = true): [boolean, (open: boolean) => void] {
  const stored = useSyncExternalStore(subscribe, () => openById[id]);
  const set = (open: boolean) => {
    openById = { ...openById, [id]: open };
    try {
      localStorage.setItem(KEY, JSON.stringify(openById));
    } catch {
      // private mode or blocked storage: keep it for this page only
    }
    for (const l of listeners) l();
  };
  return [stored ?? defaultOpen, set];
}
