import { useState, type ReactNode } from "react";

const KEY = "anomaly.gameSections.closed";

function readClosed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/**
 * One section of the Game tab: a card whose header names it and sums it up
 * (so a folded section still says what it holds). Folding is remembered in
 * this browser.
 */
export function GameSection({ id, title, summary, children }: { id: string; title: string; summary?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(() => !readClosed().has(id));
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      const closed = readClosed();
      if (next) closed.delete(id);
      else closed.add(id);
      localStorage.setItem(KEY, JSON.stringify([...closed]));
    } catch {
      // Storage unavailable: folding just isn't remembered.
    }
  };
  return (
    <section className={`game-section${open ? " open" : ""}`} data-testid={`game-section-${id}`}>
      <h3 className="game-section-head">
        <button type="button" aria-expanded={open} onClick={toggle}>
          <span className="game-section-caret caret" aria-hidden />
          <span className="game-section-title">{title}</span>
          {summary !== undefined && <span className="game-section-summary">{summary}</span>}
        </button>
      </h3>
      {open && <div className="game-section-body">{children}</div>}
    </section>
  );
}
