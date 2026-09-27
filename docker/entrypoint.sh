#!/bin/sh
# Runs as root only long enough to give /data to PUID:PGID, then drops privileges.
set -e
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  if [ "$(stat -c %u:%g /data)" != "$PUID:$PGID" ]; then
    chown -R "$PUID:$PGID" /data || echo "warning: could not chown /data" >&2
  fi
fi
exec vv "${@:-serve}"
