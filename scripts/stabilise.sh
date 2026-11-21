#!/usr/bin/env bash
# One-shot stabilisation run for a developer machine: type checks, lint, the test suite on SQLite and on Postgres,
# the Docker image and the Tauri shell. It writes stabilise-report.md (gitignored) with one line per step and the
# tail of every failure, so the result can be shared or read by an assistant without scrolling a terminal.
#
#   ./scripts/stabilise.sh            # everything it can run
#   ./scripts/stabilise.sh quick      # skip Docker image and Tauri
#
# Needs: pnpm. Optional: docker (Postgres tests, image build), cargo (Tauri shell check). Missing tools are reported as SKIP.
# It never reads .env or the dev database (apps/server/.kiln-data) and starts only a throwaway Postgres (docker-compose.test.yml).
set -u
cd "$(dirname "$0")/.."
MODE="${1:-all}"
OUT=.stabilise
REPORT=stabilise-report.md
rm -rf "$OUT"; mkdir -p "$OUT"
: > "$REPORT"
{ echo "# Stabilisation report"; echo; echo "Run: $(date -u +%Y-%m-%dT%H:%M:%SZ) · $(uname -sm) · node $(node -v 2>/dev/null) · pnpm $(pnpm -v 2>/dev/null)"; echo; } >> "$REPORT"
FAILED=0
step() { # name, command...
  local name="$1"; shift
  local log="$OUT/$(echo "$name" | tr ' /' '__').log"
  printf '%-34s' "$name ..."
  local t0=$SECONDS
  if "$@" > "$log" 2>&1; then
    echo "ok ($((SECONDS - t0)) s)"; echo "- PASS · $name ($((SECONDS - t0)) s)" >> "$REPORT"
  else
    FAILED=$((FAILED + 1))
    echo "FAILED ($((SECONDS - t0)) s) -> $log"; echo "- FAIL · $name ($((SECONDS - t0)) s) · log: $log" >> "$REPORT"
    { echo; echo "### $name: last lines"; echo '```'; tail -n 40 "$log"; echo '```'; echo; } >> "$REPORT"
  fi
}
skip() { printf '%-34s%s\n' "$1 ..." "SKIP ($2)"; echo "- SKIP · $1 · $2" >> "$REPORT"; }
have() { command -v "$1" > /dev/null 2>&1; }

if ! have pnpm; then echo "pnpm is required"; exit 2; fi
if pnpm install --frozen-lockfile > "$OUT/install-frozen.log" 2>&1; then
  step "install" pnpm install --frozen-lockfile
else
  # The lockfile is out of date: refresh it (network needed) and say so, so it can be committed.
  step "install (lockfile refreshed)" pnpm install --no-frozen-lockfile
  { echo "  pnpm-lock.yaml changed: $(git diff --shortstat -- pnpm-lock.yaml)"; } >> "$REPORT"
fi
step "typecheck" pnpm typecheck
if have biome || [ -x node_modules/.bin/biome ]; then
  step "lint (biome)" pnpm lint
  # Which rules fire how often (summary), so a formatting-only problem can be told from real findings.
  node_modules/.bin/biome check . --reporter=summary --max-diagnostics=none > "$OUT/lint-summary.txt" 2>&1
  node_modules/.bin/biome check . --diagnostic-level=error --reporter=github --max-diagnostics=none > "$OUT/lint-errors.txt" 2>&1
  { echo; echo "### lint errors (file:line, errors only)"; echo '```'; grep -E "^::error" "$OUT/lint-errors.txt" | head -80 | cut -c1-220; echo '```'; } >> "$REPORT"
  { echo; echo "### lint summary (rules by count)"; echo '```'; head -n 60 "$OUT/lint-summary.txt"; echo '```'; echo; } >> "$REPORT"
else skip "lint (biome)" "biome not installed"; fi
step "web build" pnpm build
step "tests (sqlite)" pnpm test

if have docker && docker info > /dev/null 2>&1; then
  step "postgres up" docker compose -f docker-compose.test.yml up -d --wait
  step "tests (postgres)" env KILN_TEST_POSTGRES_URL=postgres://kiln_test:kiln_test@localhost:55432/kiln_test pnpm test
  docker compose -f docker-compose.test.yml down > /dev/null 2>&1
  if [ "$MODE" != quick ]; then
    step "docker compose config" docker compose config -q
    step "docker image build" docker build -t kiln:stabilise .
  fi
else
  skip "tests (postgres)" "docker is not running"
  skip "docker image build" "docker is not running"
fi

if [ "$MODE" != quick ]; then
  if have cargo && [ -d apps/desktop/src-tauri ]; then
    # cargo check needs the staged sidecar (externalBin); this only copies files that are already on the machine.
    step "tauri sidecar stage" node apps/desktop/scripts/prepare-sidecar.mjs --allow-missing-web
    step "tauri cargo check" bash -c 'cd apps/desktop/src-tauri && cargo check'
  else
    skip "tauri cargo check" "cargo not installed"
  fi
fi

{ echo; echo "Failed steps: $FAILED"; } >> "$REPORT"
echo; echo "Report: $REPORT ($FAILED failed step(s)). Full logs: $OUT/"
exit $((FAILED > 0 ? 1 : 0))
