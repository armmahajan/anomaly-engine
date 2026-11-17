import { gameArtPlan, type ArtState, type ProjectSpec } from "@anomaly/core";
import type { Session } from "./session.ts";
import { money } from "./ArtPanel.tsx";

/**
 * "Make the art": what the game still needs drawn (core gameArtPlan) and one
 * job that does all of it, step by step, each step saved on its own. Running
 * it again picks up whatever is still missing or out of date.
 */
export function GameArtSection({ project, session, art, locked }: { project: ProjectSpec; session: Session; art: ArtState; locked: boolean }) {
  const plan = gameArtPlan(project);
  const estimate = plan.reduce((sum, s) => sum + s.estimatedCost, 0);
  const running = art.running?.stage === "gameArt" ? art.running : null;
  const last = [...art.jobs].reverse().find((j) => j.stage === "gameArt");
  return (
    <div className="game-art" data-testid="game-art">
      <h3>Art</h3>
      {plan.length === 0 ? (
        <p className="hint">Everything is drawn.</p>
      ) : (
        <>
          <p className="hint">
            {plan.length} step{plan.length === 1 ? "" : "s"} to draw the whole game, about {money(estimate)}.
          </p>
          <ul className="game-art-steps">
            {plan.slice(0, 12).map((s) => (
              <li key={s.id} data-testid={`art-step-${s.id}`}>
                {s.description}
                {s.reason === "out_of_date" && <span className="tag">changed</span>}
              </li>
            ))}
            {plan.length > 12 && <li className="muted">…and {plan.length - 12} more</li>}
          </ul>
          <button
            type="button"
            disabled={locked || !art.available || art.running !== null}
            title={art.available ? undefined : "Art generation isn't configured (no model key)"}
            onClick={() => void session.startArtJob({ stage: "gameArt" })}
          >
            Make the art
          </button>
        </>
      )}
      {running && (
        <div className="game-art-progress" data-testid="game-art-progress">
          <span>Drawing… {money(running.cost)}</span>
          <span className="muted">{running.activity.at(-1)?.text}</span>
          <button type="button" onClick={() => void session.cancelArtJob()}>
            Stop
          </button>
        </div>
      )}
      {!running && last && (
        <p className="hint" data-testid="game-art-last">
          Last run: {last.outcome}, {money(last.cost)}. {last.summary}
        </p>
      )}
    </div>
  );
}
