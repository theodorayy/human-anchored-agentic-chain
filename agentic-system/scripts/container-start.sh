#!/bin/sh
set -eu
mkdir -p /data/hac /data/eve-workflows
chown node:node /data /data/hac /data/eve-workflows
# Persist workflow state without hiding Eve's immutable compiled build assets.
if [ ! -L /app/.eve/.workflow-data ]; then
  if [ -d /app/.eve/.workflow-data ]; then
    rm -rf /app/.eve/.workflow-data
  fi
  ln -s /data/eve-workflows /app/.eve/.workflow-data
fi
exec gosu node node /app/scripts/start.mjs
