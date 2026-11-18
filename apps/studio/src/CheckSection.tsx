import { useState } from "react";
import { checkGame, type CheckResult, type LogicStep, type ProjectSpec } from "@anomaly/core";

/** Game tab: "Check the game" (agent I): runs the logic-aware checker and shows beatable / dead states with readable counterexamples. */
export function CheckSection({ project }: { project: ProjectSpec }) {
  const [running, setRunning] = useState(false);
  const [checked, setChecked] = useState<{ project: ProjectSpec; result: CheckResult } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    // Let the spinner paint: the check runs here, on this thread.
    await new Promise((resolve) => setTimeout(resolve, 30));
    try {
      setChecked({ project, result: checkGame(project) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const result = checked?.result;
  return (
    <div className="check-section" data-testid="check-section">
      <p className="hint">Proves the game can be finished from its start, with no dead ends (resumed saves included), by its real rules and physics.</p>
      <div className="check-run">
        <button onClick={() => void run()} disabled={running}>
          {running ? "Checking…" : "Check the game"}
        </button>
        {running && <span className="check-spinner" aria-label="checking" />}
        {checked && checked.project !== project && !running && <span className="hint">The game changed since this check.</span>}
      </div>
      {error && <p className="check-error">The check failed: {error}</p>}
      {result && <Verdict result={result} />}
    </div>
  );
}

function Verdict({ result }: { result: CheckResult }) {
  const dead = result.deadStates.length;
  const ok = result.beatable && dead === 0;
  const headline = !result.hasEnding ? "No ending" : result.beatable ? "Beatable" : "Not beatable";
  return (
    <div className="check-verdict">
      <p className={`check-headline ${ok ? "good" : "bad"}`} data-testid="check-verdict">
        {ok ? "✓" : "✗"} {headline}
        {result.hasEnding && (dead === 0 ? ", no dead ends" : `, ${dead} dead end${dead > 1 ? "s" : ""}`)}
      </p>
      <p className="hint">
        {result.stats.states.toLocaleString()} states in {result.stats.ms} ms{result.stats.truncated ? " (stopped early: the verdict is partial)" : ""}. Reaches {result.reachableRooms.join(", ") || "no room"}.
      </p>
      {result.deadStates.map((d, i) => (
        <div className="check-dead" key={i} data-testid="check-dead">
          <p>{d.why}</p>
          <Steps steps={d.path} label={`How to get stuck (${d.path.length} steps${d.fromSave ? ", through Continue" : ""})`} open={i === 0} />
        </div>
      ))}
      {result.route && <Steps steps={result.route} label={`A route to the ending (${result.route.length} steps)`} />}
    </div>
  );
}

function Steps({ steps, label, open = false }: { steps: LogicStep[]; label: string; open?: boolean }) {
  return (
    <details className="check-steps" open={open}>
      <summary>{label}</summary>
      <ol>
        {steps.map((s, i) => (
          <li key={i}>
            <span className="check-room">{s.room}</span> {s.action}
          </li>
        ))}
      </ol>
    </details>
  );
}
