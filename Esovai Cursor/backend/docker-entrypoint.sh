#!/bin/sh
set -e
# Named Volume ist oft root:root — UID 1001 (nodejs) braucht Schreibrecht für SQLite
if [ -d /data ]; then
  chown -R nodejs:nodejs /data 2>/dev/null || true
fi
exec su-exec nodejs:nodejs node server.js
