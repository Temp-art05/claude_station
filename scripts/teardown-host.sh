#!/bin/bash
#
# Removes everything scripts/setup-host.sh installed: the hosts alias, the pf
# redirect, and the launchd job that reloaded it at boot.
#
# Usage: sudo bash scripts/teardown-host.sh [--host claude.station]

set -euo pipefail

MARKER="# claude-station"
ANCHOR_NAME="claude-station"
ANCHOR_FILE="/etc/pf.anchors/claude-station"
PF_CONF="/etc/pf.conf"
PF_BACKUP="/etc/pf.conf.claude-station.bak"
PLIST="/Library/LaunchDaemons/com.claude-station.pf.plist"

HOST="claude.station"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="${2:?--host needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,6p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ "${EUID}" -ne 0 ]]; then
  echo "Needs root. Run: sudo bash scripts/teardown-host.sh" >&2
  exit 1
fi

# launchd first, so nothing reinstates the rules behind us.
if [[ -f "${PLIST}" ]]; then
  launchctl bootout system "${PLIST}" 2>/dev/null || true
  rm -f "${PLIST}"
  echo "  launchd      removed ${PLIST}"
fi

if grep -q "\"${ANCHOR_NAME}\"" "${PF_CONF}"; then
  # Drop only our own lines — pf.conf may have picked up unrelated edits since,
  # and restoring the backup wholesale would throw those away.
  python3 - "${PF_CONF}" "${ANCHOR_NAME}" <<'PY'
import sys

path, anchor = sys.argv[1:3]
needle = f'"{anchor}"'
lines = [l for l in open(path).read().splitlines()
         if not (needle in l and l.strip().startswith(("rdr-anchor", "load anchor")))]
open(path, "w").write("\n".join(lines) + "\n")
PY
  echo "  pf.conf      dropped the anchor lines (backup kept: ${PF_BACKUP})"
fi

if [[ -f "${ANCHOR_FILE}" ]]; then
  rm -f "${ANCHOR_FILE}"
  echo "  pf anchor    removed ${ANCHOR_FILE}"
fi

# Reload so the redirect stops applying right away.
pfctl -f "${PF_CONF}" 2>&1 | sed 's/^/               /' || true

if grep -qE "^[^#]*[[:space:]]${HOST}([[:space:]]|$)" /etc/hosts; then
  cp /etc/hosts "/etc/hosts.claude-station.bak"
  python3 - /etc/hosts "${HOST}" <<'PY'
import re, sys

path, host = sys.argv[1:3]
pattern = re.compile(rf"^[^#]*\s{re.escape(host)}(\s|$)")
lines = [l for l in open(path).read().splitlines() if not pattern.match(l)]
open(path, "w").write("\n".join(lines) + "\n")
PY
  echo "  hosts        removed ${HOST} (backup: /etc/hosts.claude-station.bak)"
fi

echo
echo "Done. Drop STATION_HOST from .env and the UI goes back to http://127.0.0.1:5173."
