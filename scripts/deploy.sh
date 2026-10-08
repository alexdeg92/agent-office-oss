#!/bin/sh
# Thin entry point. The deploy itself is scripts/deploy.js (no shell evaluation of env files).
exec node "$(CDPATH= cd -- "$(dirname "$0")" && pwd)/deploy.js" "$@"
