import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

/**
 * Open state for a menu or popover anchored in `ref`: a click outside it or
 * Escape closes it (Escape gives the focus back to its trigger, `[aria-haspopup]`).
 */
export function usePopover<T extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false);
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      ref.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
    };
    // A click in the game iframe never reaches this window, but it takes the focus away from it.
    const onBlur = () => setOpen(false);
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);
  return { open, setOpen, ref };
}

/** ↑/↓/Home/End between a menu's items (role="menuitem" / "menuitemcheckbox"). */
export function menuKeyDown(e: ReactKeyboardEvent<HTMLElement>): void {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)')];
  if (items.length === 0) return;
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === "ArrowDown" ? (at + 1) % items.length
    : e.key === "ArrowUp" ? (at - 1 + items.length) % items.length
    : e.key === "Home" ? 0
    : e.key === "End" ? items.length - 1
    : null;
  if (next === null) return;
  e.preventDefault();
  items[next]!.focus();
}
