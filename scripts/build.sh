#!/usr/bin/env bash
# Compile olle to dist/olle.
#
# `bun build --compile` writes a `.<hash>-NNNN.bun-build` temp in CWD and
# renames it to --outfile on success. Any interruption (Ctrl-C, SIGKILL,
# OOM) between write and rename orphans the temp. Sweep before and on
# exit so consecutive builds and crashed prior runs don't leave litter.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

sweep() { rm -f .*.bun-build 2>/dev/null || true; }
trap sweep EXIT
sweep

bun build --compile --target=bun ./src/cli/index.ts --outfile=dist/olle
