#!/usr/bin/env bash
# Launcher of openspec-tasks.mts (TypeScript run by Node).
# Finds node even outside the PATH of an interactive shell (nvm).
NODE=$(command -v node) || NODE=$(ls -v "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1)
exec "$NODE" "$(dirname "$(readlink -f "$0")")/openspec-tasks.mts" "$@"
