#!/bin/sh
# Export current files, never history. Destination must be absent or empty.
set -eu
cd "$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  printf '%s\n' 'usage: packaging/export-public.sh <outdir>' >&2
  exit 2
fi
node packaging/export-public.js "$1"
node packaging/check-public.js "$1"
