#!/usr/bin/env bash
# Run a heavy command (tests, renders, Godot exports, evals) inside the shared, capped
# anomaly-heavy.slice (~/.config/systemd/user/anomaly-heavy.slice): together they get at most
# ~5 GB of memory and a low CPU/IO share, so SSH and the studios stay responsive. Falls back to
# a plain low-priority run where systemd user scopes aren't available.
#   scripts/heavy.sh npx vitest run
set -euo pipefail
if systemctl --user cat anomaly-heavy.slice >/dev/null 2>&1; then
  exec systemd-run --user --scope --quiet --slice=anomaly-heavy.slice --collect nice -n 10 "$@"
fi
exec nice -n 10 "$@"
