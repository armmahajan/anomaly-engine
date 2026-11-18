import { useEffect, useRef, useState } from "react";
import { checkGame, type CheckResult, type ExportedFile, type GameExportSummary, type ProjectSpec } from "@anomaly/core";
import * as api from "../api.ts";

type Step =
  | { kind: "checking" }
  /** The check didn't prove the game can be finished (or failed): export anyway, or cancel. */
  | { kind: "unproven"; result: CheckResult | null; error: string | null }
  | { kind: "building"; proven: boolean }
  | { kind: "done"; summary: GameExportSummary; proven: boolean }
  | { kind: "failed"; message: string };

const KIND_LABEL: Record<ExportedFile["kind"], string> = {
  runtime: "Game runtime (web)",
  art: "Art",
  data: "Game data",
  page: "Start page",
  readme: "How to host it",
};

/**
 * Project menu ▸ Export game…: checks the game (checkGame), then builds the standalone web game on
 * the server and downloads its zip. A game the check doesn't prove beatable is said so here, and
 * exports only when the creator chooses to.
 */
export function ExportGameDialog({ project, onClose }: { project: ProjectSpec; onClose: () => void }) {
  const [step, setStep] = useState<Step>({ kind: "checking" });
  const actionsRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  const build = async (proven: boolean) => {
    setStep({ kind: "building", proven });
    const result = await api.exportGame();
    if (!result.ok) {
      setStep({ kind: "failed", message: result.error.message });
      return;
    }
    setStep({ kind: "done", summary: result.export, proven });
    download(result.export.zip);
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      if (!project.world.start) {
        setStep({ kind: "failed", message: "The game has no start: set one in Rooms (📍 Spot, then Set start here) before exporting." });
        return;
      }
      // Let "Checking…" paint: the check runs on this thread.
      await new Promise((resolve) => setTimeout(resolve, 30));
      let result: CheckResult;
      try {
        result = checkGame(project);
      } catch (e) {
        setStep({ kind: "unproven", result: null, error: e instanceof Error ? e.message : String(e) });
        return;
      }
      if (result.beatable && result.deadStates.length === 0 && !result.stats.truncated) void build(true);
      else setStep({ kind: "unproven", result, error: null });
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus Close when done or failed; Cancel (not Export anyway) when the game isn't proven.
  useEffect(() => {
    actionsRef.current?.querySelector<HTMLElement>(step.kind === "unproven" ? "button" : "button.primary")?.focus();
  }, [step.kind]);

  const busy = step.kind === "checking" || step.kind === "building";
  const close = () => {
    if (!busy) onClose();
  };

  return (
    <div className="confirm-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className="confirm-dialog export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        aria-busy={busy}
        data-testid="export-dialog"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <h2 id="export-title">Export {project.name}</h2>
        {step.kind === "checking" && <p className="confirm-message export-progress">Checking the game…</p>}
        {step.kind === "unproven" && <Unproven result={step.result} error={step.error} />}
        {step.kind === "building" && <p className="confirm-message export-progress">Building the web game…</p>}
        {step.kind === "failed" && (
          <p className="confirm-message export-error" role="alert">
            The export failed: {step.message}
          </p>
        )}
        {step.kind === "done" && <Done summary={step.summary} proven={step.proven} />}
        <div className="confirm-actions" ref={actionsRef}>
          {step.kind === "unproven" && (
            <>
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="primary" onClick={() => void build(false)}>
                Export anyway
              </button>
            </>
          )}
          {step.kind === "done" && (
            <a className="button-link" href={api.exportUrl(step.summary.zip)} download={step.summary.zip}>
              Download again
            </a>
          )}
          {(step.kind === "done" || step.kind === "failed") && (
            <button type="button" className="primary" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Unproven({ result, error }: { result: CheckResult | null; error: string | null }) {
  if (!result) {
    return (
      <div className="confirm-message">
        <p className="export-warning">The game check failed ({error}), so it isn't proven that this game can be finished.</p>
        <p>Export it anyway?</p>
      </div>
    );
  }
  const dead = result.deadStates.length;
  const verdict = !result.hasEnding
    ? "it has no ending"
    : !result.beatable
      ? "it can't be finished from its start"
      : dead > 0
        ? `it has ${dead} dead end${dead > 1 ? "s" : ""} (places a player can get stuck)`
        : "the check stopped early, so its verdict is partial";
  return (
    <div className="confirm-message">
      <p className="export-warning" data-testid="export-verdict">
        ✗ The game check didn't prove this game can be finished: {verdict}.
      </p>
      {result.deadStates.length > 0 && (
        <ul className="export-reasons">
          {result.deadStates.slice(0, 3).map((d, i) => (
            <li key={i}>{d.why}</li>
          ))}
        </ul>
      )}
      <p>The Game tab's Check the game shows how. Export it anyway?</p>
    </div>
  );
}

function Done({ summary, proven }: { summary: GameExportSummary; proven: boolean }) {
  const groups = (Object.keys(KIND_LABEL) as ExportedFile["kind"][])
    .map((kind) => {
      const files = summary.files.filter((f) => f.kind === kind);
      return { kind, count: files.length, bytes: files.reduce((sum, f) => sum + f.bytes, 0) };
    })
    .filter((g) => g.count > 0);
  return (
    <div className="confirm-message export-done" data-testid="export-done">
      <p>
        {proven ? "✓ Checked: the game can be finished. " : ""}
        Downloading <b>{summary.zip}</b>: <span data-testid="export-size">{formatBytes(summary.zipBytes)}</span> ({formatBytes(summary.folderBytes)} unzipped,{" "}
        {summary.files.length} files).
      </p>
      <table className="export-contents">
        <tbody>
          {groups.map((g) => (
            <tr key={g.kind}>
              <td>{KIND_LABEL[g.kind]}</td>
              <td>
                {g.count} file{g.count > 1 ? "s" : ""}
              </td>
              <td>{formatBytes(g.bytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <details>
        <summary>Every file</summary>
        <ul className="export-files">
          {summary.files.map((f) => (
            <li key={f.path}>
              {f.path} <small>{formatBytes(f.bytes)}</small>
            </li>
          ))}
        </ul>
      </details>
      <p className="hint">
        Unzip it and put the folder on any static web host (itch.io, GitHub Pages, your own server); index.html starts the game on its title. Saves stay in
        each player's browser. Nothing else of the project is in it.
      </p>
    </div>
  );
}

function download(zip: string) {
  const link = document.createElement("a");
  link.href = api.exportUrl(zip);
  link.download = zip;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
