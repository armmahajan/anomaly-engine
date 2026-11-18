import type { PointerEvent, ReactNode } from "react";
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from "../layout.ts";
import { listKeyDown } from "./listKeys.ts";

export interface SideResize {
  width: number;
  startResize: (e: PointerEvent<HTMLElement>) => void;
  setWidth: (width: number) => void;
}

/**
 * The side panel between the stage and the chat, the same frame on every tab:
 * a resize handle on its left edge (drag, ←/→ when focused, double-click to
 * reset), keyboard navigation of its lists (listKeys.ts), and a footer (the
 * last problem) that stays in view at the bottom however long the panel is.
 */
export function SidePanel({ label, resize, footer, children }: { label: string; resize: SideResize; footer?: ReactNode; children: ReactNode }) {
  const { width, startResize, setWidth } = resize;
  return (
    <aside className="sidebar side-panel" aria-label={label} onKeyDown={listKeyDown}>
      <div
        className="side-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the side panel"
        aria-valuenow={width}
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={SIDEBAR_MAX}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={startResize}
        onDoubleClick={() => setWidth(SIDEBAR_DEFAULT)}
        onKeyDown={(e) => {
          // The panel grows to the left: ← widens it, → narrows it.
          const step = e.shiftKey ? 64 : 16;
          if (e.key === "ArrowLeft") setWidth(width + step);
          else if (e.key === "ArrowRight") setWidth(width - step);
          else if (e.key === "Home") setWidth(SIDEBAR_DEFAULT);
          else return;
          e.preventDefault();
        }}
      />
      <div className="side-panel-body">{children}</div>
      {footer && <div className="side-panel-footer">{footer}</div>}
    </aside>
  );
}
