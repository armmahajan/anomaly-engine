import { useSyncExternalStore } from "react";
import type { ArtJobRequest } from "@anomaly/core";
import type { Session } from "./session.ts";

/**
 * Starts one art job (props, a modal's image, item icons). Shows that it runs
 * and, after, how the last job of its stage went.
 */
export function ArtJobButton({ session, request, label, cost, locked, nothing }: { session: Session; request: ArtJobRequest; label: string; cost: string; locked: boolean; nothing?: string }) {
  const { art } = useSyncExternalStore(session.subscribe, session.getState);
  // Jobs of other kinds run alongside (or queue behind what they conflict with); only the same kind of job blocks this button.
  const running = art.runningJobs.some((j) => j.stage === request.stage) || art.pending.some((p) => p.stage === request.stage);
  const last = [...art.jobs].reverse().find((j) => j.stage === request.stage);
  const title = !art.available ? "Art generation is off (no model key)" : nothing ?? (running ? "This art job is running" : `About ${cost}`);
  return (
    <span className="art-job">
      <button type="button" title={title} disabled={locked || !art.available || running || !!nothing} onClick={() => void session.startArtJob(request)}>
        {running ? "Drawing…" : label}
      </button>
      {!running && last && last.outcome !== "committed" && <span className="art-job-error">{last.error ?? last.outcome}</span>}
    </span>
  );
}
