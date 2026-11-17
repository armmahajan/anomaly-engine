import { useSyncExternalStore } from "react";
import type { ArchitectRunRequest } from "@anomaly/core";
import type { Session } from "../session.ts";

/**
 * View state shared by the Architect's two panes (the run in the sidebar, the
 * plan in the main pane): which room cards are open, and which one was last
 * asked for (an issue's "Show room", a link to another room). Module-level so
 * App needn't carry it; it is only view state, never the project.
 */
export interface ArchitectUi {
  expanded: ReadonlySet<string>;
  /** The card to bring into view; `nonce` changes on every request so asking twice scrolls twice. */
  focus: { roomId: string; nonce: number } | null;
}

let state: ArchitectUi = { expanded: new Set(), focus: null };
const listeners = new Set<() => void>();

function set(next: ArchitectUi) {
  state = next;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useArchitectUi = () => useSyncExternalStore(subscribe, () => state);

export function toggleRoom(roomId: string, open?: boolean) {
  const expanded = new Set(state.expanded);
  if (open ?? !expanded.has(roomId)) expanded.add(roomId);
  else expanded.delete(roomId);
  set({ ...state, expanded });
}

export function setExpanded(roomIds: string[]) {
  set({ ...state, expanded: new Set(roomIds) });
}

/** Open a room's card and bring it into view. */
export function showRoom(roomId: string) {
  const expanded = new Set(state.expanded).add(roomId);
  set({ expanded, focus: { roomId, nonce: (state.focus?.nonce ?? 0) + 1 } });
}

// --- starting and stopping runs -------------------------------------------------
// A run shows as under way from the click, before the server's first event. A
// Stop asked for while it starts is sent as soon as the server reports the run
// (its event) or accepts it (the start request), whichever comes first.

export interface RunControl {
  starting: boolean;
  stopping: boolean;
}

let run: RunControl = { starting: false, stopping: false };
/** The run (its startedAt) a cancel was already sent for. */
let cancelledRun: string | null = null;
const runListeners = new Set<() => void>();
const setRun = (next: RunControl) => {
  run = next;
  for (const l of runListeners) l();
};
const subscribeRun = (l: () => void) => {
  runListeners.add(l);
  return () => runListeners.delete(l);
};

export const useRunControl = () => useSyncExternalStore(subscribeRun, () => run);

type Runs = Pick<Session, "startArchitect" | "cancelArchitect">;

export async function startRun(session: Runs, request: ArchitectRunRequest) {
  if (run.starting) return;
  setRun({ starting: true, stopping: false });
  try {
    const ok = await session.startArchitect(request);
    if (ok && run.stopping) await session.cancelArchitect();
  } finally {
    setRun({ ...run, starting: false });
  }
}

/**
 * Stop: ask now (the server stops the run after its current stage; with no run
 * yet it is a no-op), and again once a run that was still starting is reported.
 */
export async function stopRun(session: Runs, running: { startedAt: string } | null) {
  setRun({ ...run, stopping: true });
  if (running) cancelledRun = running.startedAt;
  await session.cancelArchitect();
}

/** The server reported a run: if Stop was asked for while it started, stop it now. */
export function runReported(session: Runs, running: { startedAt: string } | null) {
  if (!running || !run.stopping || cancelledRun === running.startedAt) return;
  cancelledRun = running.startedAt;
  void session.cancelArchitect();
}
