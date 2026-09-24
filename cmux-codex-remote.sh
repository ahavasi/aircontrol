#!/usr/bin/env bash
# cmux invokes this after adding its per-session hook overrides. Explicitly
# selecting the local app server keeps those overrides while preventing Codex
# from falling back to a private embedded server. The daemon is shared, so its
# own launch directory is not the terminal's project; pass the caller's PWD
# explicitly for every new client.
set -euo pipefail

codex_bin="${AIRCONTROL_CODEX_BINARY:-$HOME/.codex/packages/standalone/current/codex}"
socket="${AIRCONTROL_CODEX_SOCKET:-$HOME/.codex/app-server-control/app-server-control.sock}"

if [[ ! -x "$codex_bin" ]]; then
  echo "aircontrol: managed Codex binary is unavailable: $codex_bin" >&2
  exit 127
fi
if [[ ! -S "$socket" ]]; then
  "$codex_bin" app-server daemon start >/dev/null 2>&1 || true
fi
if [[ ! -S "$socket" ]]; then
  echo "aircontrol: local Codex daemon is unavailable" >&2
  exit 1
fi

exec "$codex_bin" --remote "unix://$socket" --cd "$PWD" "$@"
