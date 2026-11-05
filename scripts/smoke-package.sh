#!/usr/bin/env bash
# Packs the project, installs the tarball the way a user would, and exercises the CLI.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
errors="$work/stderr"
trap 'status=$?; if [ "$status" -ne 0 ] && [ -s "$errors" ]; then cat "$errors" >&2; fi; rm -rf "$work"' EXIT
cd "$root"

tarball="$(npm pack --silent --pack-destination "$work" | tail -1)"
npm install --global --prefix "$work/prefix" "$work/$tarball"
bin="$work/prefix/bin/paywings"
export PAYWINGS_DB="$work/sandbox.db"

expected="$(node -p "require('./package.json').version")"
actual="$("$bin" --version 2>>"$errors")"
if [ "$actual" != "$expected" ]; then
  echo "version mismatch: got '$actual', expected '$expected'" >&2
  exit 1
fi

"$bin" --help >/dev/null 2>>"$errors"
init_output="$("$bin" init 2>>"$errors")"
PAYWINGS_AGENT_KEY="$(printf '%s\n' "$init_output" | grep -o 'pw_test_[A-Za-z0-9_-]*' | head -1)"
export PAYWINGS_AGENT_KEY

"$bin" pay --amount 9.90 --rail card --merchant Vercel --domain vercel.com \
  --category software --reason "package smoke test" 2>>"$errors" | grep -q '"status": "executed"'

if grep -q 'ExperimentalWarning' "$errors"; then
  cat "$errors" >&2
  echo "unexpected experimental warning on stderr" >&2
  exit 1
fi

echo "package smoke test passed (paywings $expected)"
