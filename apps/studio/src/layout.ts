import { useCallback, useState, type PointerEvent } from "react";

/** Per-browser layout preferences (sidebar width, chat open). Storage can fail; defaults always work. */

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode or blocked storage: keep the in-memory value only
  }
}

export const SIDEBAR_MIN = 240;
export const SIDEBAR_MAX = 720;

/** Sidebar width, and a pointer-down handler for its left-edge drag handle. */
export function useSidebarWidth(): [number, (e: PointerEvent<HTMLElement>) => void] {
  const [width, setWidth] = useState(() => load("anomaly.sidebarWidth", 320));
  const startResize = useCallback((e: PointerEvent<HTMLElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    let latest = startWidth;
    const move = (ev: globalThis.PointerEvent) => {
      latest = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + (startX - ev.clientX)));
      setWidth(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
      save("anomaly.sidebarWidth", latest);
    };
    // The game iframe would swallow pointer events mid-drag; .resizing turns them off.
    document.body.classList.add("resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [width]);
  return [width, startResize];
}

export function useChatOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => load("anomaly.chatOpen", true));
  return [
    open,
    (next) => {
      setOpen(next);
      save("anomaly.chatOpen", next);
    },
  ];
}
