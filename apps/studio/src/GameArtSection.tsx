import { artDirectionWanted, gameArtPlan, isDefaultArtDirection, type ArtState, type ProjectSpec } from "@anomaly/core";
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
  const groups = stepGroups(plan);
  const changed = plan.filter((s) => s.reason === "out_of_date").length;
  return (
    <div className="game-art" data-testid="game-art">
      <ArtDirectionView project={project} session={session} art={art} locked={locked} />
      {plan.length === 0 ? (
        <p className="hint">Everything is drawn.</p>
      ) : (
        <>
          <p className="hint">
            {plan.length} step{plan.length === 1 ? "" : "s"} to draw the whole game, about {money(estimate)}.
          </p>
          <details className="game-art-details" data-testid="game-art-steps">
            <summary>
              {groups.map((g) => `${g.count} ${g.count === 1 ? g.one : g.many}`).join(" · ")}
              {changed > 0 && ` · ${changed} out of date`}
            </summary>
            {groups.map((g) => (
              <div key={g.kind} className="game-art-group">
                <h4>
                  {g.count} {g.count === 1 ? g.one : g.many}
                  <span className="hint"> · about {money(g.cost)}</span>
                </h4>
                <ul className="game-art-steps">
                  {plan
                    .filter((s) => s.kind === g.kind)
                    .map((s) => (
                      <li key={s.id} data-testid={`art-step-${s.id}`}>
                        {s.description}
                        {s.reason === "out_of_date" && <span className="tag">changed</span>}
                        {s.reason === "incomplete" && <span className="tag">incomplete</span>}
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </details>
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

const KIND_NAMES: Record<string, [string, string]> = {
  direction: ["art direction", "art direction"],
  character: ["character", "characters"],
  biome: ["biome kit", "biome kits"],
  room: ["room to dress", "rooms to dress"],
  props: ["prop set", "prop sets"],
  modal: ["screen", "screens"],
  items: ["item sheet", "item sheets"],
};

/** The plan's steps by kind, in plan order, with their count and estimated cost. */
function stepGroups(plan: ReturnType<typeof gameArtPlan>) {
  const kinds = [...new Set(plan.map((s) => s.kind as string))];
  return kinds.map((kind) => {
    const steps = plan.filter((s) => s.kind === kind);
    const [one, many] = KIND_NAMES[kind] ?? [kind, kind];
    return { kind, one, many, count: steps.length, cost: steps.reduce((n, s) => n + s.estimatedCost, 0) };
  });
}

/** The art section's one-line summary (shown in its header, folded or not). */
export function GameArtSummary({ project }: { project: ProjectSpec }) {
  const plan = gameArtPlan(project);
  if (plan.length === 0) return <>all drawn</>;
  return (
    <>
      {plan.length} step{plan.length === 1 ? "" : "s"} to draw · ~{money(plan.reduce((n, s) => n + s.estimatedCost, 0))}
    </>
  );
}

/**
 * The game's look (art.direction), which every image prompt adds. While it is a default, it can
 * be written from the wiki (the art direction job; "Make the art" does it first).
 */
function ArtDirectionView({ project, session, art, locked }: { project: ProjectSpec; session: Session; art: ArtState; locked: boolean }) {
  const { direction } = project.art;
  const isDefault = isDefaultArtDirection(direction);
  const wanted = artDirectionWanted(project);
  const running = art.running?.stage === "artDirection";
  return (
    <div className="art-direction" data-testid="art-direction">
      <div className="art-direction-head">
        <span>Look</span>
        {isDefault && <span className="tag">default</span>}
        <span className="art-direction-palette">
          {direction.palette.map((c, i) => (
            <span key={`${c}${i}`} className="swatch" style={{ background: c }} title={c} />
          ))}
        </span>
      </div>
      <p className="hint" data-testid="art-direction-style">
        {direction.style}
      </p>
      {isDefault && (
        <button
          type="button"
          data-testid="art-direction-write"
          disabled={locked || !art.available || art.running !== null || !wanted}
          title={wanted ? "Write the look from the wiki's overview and places" : "Write the wiki's overview first"}
          onClick={() => void session.startArtJob({ stage: "artDirection" })}
        >
          {running ? "Writing…" : "Write it from the wiki"}
        </button>
      )}
    </div>
  );
}
