#!/usr/bin/env bash
# Test double of a project's test-database script: test-database.sh <create|drop|url> <change> <label>
case "$1" in
  url) echo "postgresql://fixture/$2__$3" ;;
esac
