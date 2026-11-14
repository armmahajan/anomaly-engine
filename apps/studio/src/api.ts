import {
  fail,
  type BatchRequest,
  ProjectEvent,
  type ChangeResult,
  type OperationRequest,
  type PlaytestResult,
  type ProjectState,
  type UndoRequest,
} from "@anomaly/core";

/** Thin client for the local project server. Network failures become `unavailable` results. */

async function post<T>(path: string, body: unknown): Promise<T | ReturnType<typeof fail>> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as T;
  } catch (error) {
    return fail("unavailable", `project server unreachable: ${String(error)}`);
  }
}

export async function fetchProject(): Promise<ProjectState> {
  const res = await fetch("/api/project");
  if (!res.ok) throw new Error(`GET /api/project failed with ${res.status}`);
  return (await res.json()) as ProjectState;
}

export const applyOperation = (request: OperationRequest) => post<ChangeResult>("/api/ops", request);
export const applyBatch = (request: BatchRequest) => post<ChangeResult>("/api/batch", request);
export const undo = (request: UndoRequest) => post<ChangeResult>("/api/undo", request);
export const setPlaytest = (active: boolean, clientId: string) =>
  post<PlaytestResult>("/api/playtest", { active, clientId });

/** Subscribe to project changes. EventSource reconnects on its own. */
export function subscribeToProject(
  clientId: string,
  onEvent: (event: ProjectEvent) => void,
  onConnection: (connected: boolean) => void,
  onProblem: (problem: string) => void,
): () => void {
  const source = new EventSource(`/api/events?clientId=${encodeURIComponent(clientId)}`);
  source.onopen = () => onConnection(true);
  source.onerror = () => onConnection(false);
  source.onmessage = (message) => {
    let json: unknown;
    try {
      json = JSON.parse(message.data as string);
    } catch {
      onProblem("ignored unreadable server event");
      return;
    }
    const parsed = ProjectEvent.safeParse(json);
    if (parsed.success) onEvent(parsed.data);
    else onProblem(`ignored invalid server event: ${parsed.error.issues[0]?.message}`);
  };
  return () => source.close();
}
