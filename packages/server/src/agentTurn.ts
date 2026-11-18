import { applyOperation, type OperationCall, type ProjectSpec } from "@anomaly/core";
import type { AgentProfile, TurnRunner } from "@anomaly/agent";

/**
 * One agent turn on a private copy of the project: its edits are applied to the
 * copy, not to the store. The caller saves them (an Architect stage commits the
 * copy; background work applies `operations` again to the project as it is then).
 */
export async function privateTurn(
  runner: TurnRunner,
  agent: AgentProfile,
  project: ProjectSpec,
  message: string,
  ctx: { signal: AbortSignal; log: (text: string) => void },
): Promise<{ project: ProjectSpec; reply: string; operations: OperationCall[] }> {
  let current = project;
  let operations: OperationCall[] = [];
  const result = await runner({
    project,
    history: [],
    userMessage: message,
    agent,
    signal: ctx.signal,
    onEvent: (e) => {
      if (e.type === "tool_result") ctx.log(`${agent.id}: ${e.name}${e.ok ? "" : " (failed)"}`);
    },
    commit: async (calls: OperationCall[]) => {
      let next = project;
      for (const call of calls) {
        const applied = applyOperation(next, call.name, call.input);
        if (!applied.ok) return applied;
        next = applied.project;
      }
      current = { ...next, revision: project.revision };
      operations = calls;
      return { ok: true, project: current, canUndo: true };
    },
  });
  if (result.outcome === "model_error" || result.outcome === "cancelled") throw new Error(`${agent.id} turn ${result.outcome}: ${result.reply.slice(0, 300)}`);
  return { project: current, reply: result.reply, operations };
}
