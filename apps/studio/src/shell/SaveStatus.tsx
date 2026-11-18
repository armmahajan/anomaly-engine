/**
 * Whether the creator's work is safe: every edit is saved on the project
 * server as it is made, so the only states are saved and offline.
 */
export function SaveStatus({ connected, revision }: { connected: boolean; revision: number }) {
  return connected ? (
    <span
      className="save-status saved"
      data-testid="save-status"
      title={`Every change is saved on the project server as you make it (change #${revision}). Undo steps back through them.`}
    >
      Saved
    </span>
  ) : (
    <span
      className="save-status offline"
      data-testid="save-status"
      role="status"
      title="The studio can't reach the project server. Changes can't be saved until it reconnects (it retries by itself)."
    >
      Offline: not saving
    </span>
  );
}
