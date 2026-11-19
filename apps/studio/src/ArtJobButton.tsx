import { useSyncExternalStore } from "react";
import type { ArtJobRequest } from "@anomaly/core";

const SUBJECTS = ["characterId", "objectId", "biomeId", "weaponId", "worldRoomId", "modalId"] as const;

/** A running or queued job is this request's job: the same stage, for the same character, biome, weapon, room or screen. */
export function sameJob(job: Partial<Record<(typeof SUBJECTS)[number], string>> & { stage: string }, request: ArtJobRequest): boolean {
  return job.stage === request.stage && SUBJECTS.every((k) => job[k] === undefined || request[k] === undefined || job[k] === request[k]);
}
import type { Session } from "./session.ts";

/**
 * Starts one art job (props, a modal's image, item icons). Shows that it runs
 * and, after, how the last job of its stage went.
 */
export function ArtJobButton({ session, request, label, cost, locked, nothing }: { session: Session; request: ArtJobRequest; label: string; cost: string; locked: boolean; nothing?: string }) {
  const { art } = useSyncExternalStore(session.subscribe, session.getState);
  // Other jobs run alongside (or queue behind what they conflict with); only this same job (its stage, for the same subject) blocks the button.
  const running = art.runningJobs.some((j) => sameJob(j, request)) || art.pending.some((p) => sameJob(p, request));
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
