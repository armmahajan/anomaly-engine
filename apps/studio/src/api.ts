import {
  fail,
  type AgentId,
  type BatchRequest,
  ServerEvent,
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

export class UnauthorizedError extends Error {}

export async function fetchProject(): Promise<ProjectState> {
  const res = await fetch("/api/project");
  if (res.status === 401) throw new UnauthorizedError("missing studio token");
  if (!res.ok) throw new Error(`GET /api/project failed with ${res.status}`);
  return (await res.json()) as ProjectState;
}

export const applyOperation = (request: OperationRequest) => post<ChangeResult>("/api/ops", request);
export const applyBatch = (request: BatchRequest) => post<ChangeResult>("/api/batch", request);
export const undo = (request: UndoRequest) => post<ChangeResult>("/api/undo", request);
export const resetProject = (baseRevision: number) => post<ChangeResult>("/api/reset", { baseRevision });
export const sendChat = (agent: AgentId, message: string) => post<{ ok: true }>(`/api/chat?agent=${agent}`, { message });
export const cancelChat = (agent: AgentId) => post<{ ok: true }>(`/api/chat/cancel?agent=${agent}`, {});
export const setPlaytest = (active: boolean, clientId: string) =>
  post<PlaytestResult>("/api/playtest", { active, clientId });

/** Subscribe to project and chat changes. EventSource reconnects on its own. */
export function subscribeToServer(
  clientId: string,
  onEvent: (event: ServerEvent) => void,
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
    const parsed = ServerEvent.safeParse(json);
    if (parsed.success) onEvent(parsed.data);
    else onProblem(`ignored invalid server event: ${parsed.error.issues[0]?.message}`);
  };
  return () => source.close();
}
