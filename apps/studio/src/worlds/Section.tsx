import { useState, type ReactNode } from "react";

const stored = (key: string): boolean | null => {
  try {
    const v = localStorage.getItem(`anomaly-section:${key}`);
    return v === null ? null : v === "1";
  } catch {
    return null;
  }
};

/**
 * A collapsible side-panel section: a heading row (title, an optional count or
 * note, actions on the right) over its body. Open/closed is remembered per
 * browser under `id`.
 */
export function Section({
  id,
  title,
  note,
  actions,
  defaultOpen = true,
  children,
  testId,
  top = false,
}: {
  id: string;
  /** The panel's first, main section (styled as its title). */
  top?: boolean;
  title: ReactNode;
  note?: ReactNode;
  actions?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(() => stored(id) ?? defaultOpen);
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(`anomaly-section:${id}`, open ? "0" : "1");
    } catch {
      // not remembered
    }
  };
  return (
    <section className={`side-section${open ? " open" : ""}${top ? " top" : ""}`} data-testid={testId}>
      <div className="side-section-head">
        <button type="button" className="side-section-toggle" aria-expanded={open} onClick={toggle}>
          <span className="chevron" aria-hidden>
            ▸
          </span>
          <span className="side-section-title">{title}</span>
          {note !== undefined && <span className="side-section-note">{note}</span>}
        </button>
        {actions && <span className="side-section-actions">{actions}</span>}
      </div>
      {open && <div className="side-section-body">{children}</div>}
    </section>
  );
}
