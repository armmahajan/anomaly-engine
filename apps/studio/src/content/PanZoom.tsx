import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** The size of an element, kept up to date. */
export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

interface View {
  s: number;
  x: number;
  y: number;
}

const MIN = 0.25;
const MAX = 3;
const MARGIN = 16;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The whole drawing in view, centred, never blown up past `maxFit`. */
export function fitView(box: { width: number; height: number }, content: { width: number; height: number }, maxFit = 1.4): View {
  if (box.width <= 0 || box.height <= 0) return { s: 1, x: 0, y: 0 };
  const s = clamp(Math.min((box.width - 2 * MARGIN) / content.width, (box.height - 2 * MARGIN) / content.height), MIN, maxFit);
  return { s, x: (box.width - content.width * s) / 2, y: Math.max(MARGIN, (box.height - content.height * s) / 2) };
}

/**
 * An SVG drawing that fills its box: it starts fitted, then pans (drag, or
 * scroll) and zooms (ctrl/⌘ + scroll, pinch, or the buttons). A drag never
 * counts as a click on what it started on. `resetKey` changing refits.
 */
export function PanZoom({
  box,
  content,
  resetKey,
  children,
  svgProps,
}: {
  box: { width: number; height: number };
  content: { width: number; height: number };
  resetKey: string;
  children: ReactNode;
  svgProps?: React.SVGProps<SVGSVGElement> & Record<`data-${string}`, string>;
}) {
  const [manual, setManual] = useState<View | null>(null);
  const fitted = fitView(box, content);
  const view = manual ?? fitted;
  const viewRef = useRef(view);
  viewRef.current = view;
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null);
  const swallowClick = useRef(false);

  useEffect(() => setManual(null), [resetKey]);

  const zoomAt = (factor: number, cx: number, cy: number) => {
    const v = viewRef.current;
    const s = clamp(v.s * factor, MIN, MAX);
    const k = s / v.s;
    setManual({ s, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k });
  };

  // Wheel: a native listener, so it can keep the page from scrolling.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top);
      else {
        const v = viewRef.current;
        setManual({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, view: viewRef.current, moved: false };
    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = ev.clientX - d.x;
      const dy = ev.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      ref.current?.classList.add("panning");
      setManual({ ...d.view, x: d.view.x + dx, y: d.view.y + dy });
    };
    const up = () => {
      if (drag.current?.moved) swallowClick.current = true;
      drag.current = null;
      ref.current?.classList.remove("panning");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const zoomButton = (factor: number) => zoomAt(factor, box.width / 2, box.height / 2);
  return (
    <div
      ref={ref}
      className="pan-zoom"
      onPointerDown={onPointerDown}
      onClickCapture={(e) => {
        if (swallowClick.current) {
          swallowClick.current = false;
          e.stopPropagation();
        }
      }}
    >
      <svg width={box.width} height={box.height} {...svgProps}>
        <g transform={`translate(${view.x},${view.y}) scale(${view.s})`}>{children}</g>
      </svg>
      <div className="pan-zoom-controls" onPointerDown={(e) => e.stopPropagation()}>
        <button type="button" aria-label="Zoom out" title="Zoom out (ctrl/⌘ + scroll)" onClick={() => zoomButton(1 / 1.25)}>
          −
        </button>
        <span className="pan-zoom-level" aria-live="polite">
          {Math.round(view.s * 100)}%
        </span>
        <button type="button" aria-label="Zoom in" title="Zoom in (ctrl/⌘ + scroll)" onClick={() => zoomButton(1.25)}>
          +
        </button>
        <button type="button" title="Fit the whole graph in view" disabled={manual === null} onClick={() => setManual(null)}>
          Fit
        </button>
      </div>
    </div>
  );
}
