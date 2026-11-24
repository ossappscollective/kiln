#!/usr/bin/env bash
# Starts a Kiln image and checks it the way a self-hoster meets it: the container stays up, runs
# as a normal user, applies its migrations to a fresh SQLite volume, answers /api/health with
# status ok and the expected version, and serves the web UI.
#
#   scripts/release/docker-smoke.sh <image> [expected-version]
set -euo pipefail

image="${1:?usage: docker-smoke.sh <image> [expected-version]}"
expected="${2:-}"
name="kiln-smoke-$$"
port="${KILN_SMOKE_PORT:-18787}"
fail=0

cleanup() {
  local rc=$?
  if [ "$fail" -ne 0 ] || [ "$rc" -ne 0 ]; then
    echo "--- container logs ---"
    docker logs "$name" 2>&1 | tail -n 80 || true
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
die() { echo "::error::$*"; fail=1; exit 1; }

key="$(openssl rand -base64 32)"
docker run -d --name "$name" -e KILN_MASTER_KEY="$key" -p "127.0.0.1:${port}:8787" "$image" >/dev/null

health=""
for _ in $(seq 1 60); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != true ]; then die "container exited during start-up"; fi
  if health="$(curl -fsS "http://127.0.0.1:${port}/api/health" 2>/dev/null)"; then break; fi
  health=""
  sleep 1
done
[ -n "$health" ] || die "/api/health did not answer within 60 s"
echo "health: $health"

compact="$(printf '%s' "$health" | tr -d ' \n')"
case "$compact" in *'"status":"ok"'*) ;; *) die "health status is not ok" ;; esac
case "$compact" in *'"ok":true'*) ;; *) die "health says the database is not ok" ;; esac
if [ -n "$expected" ]; then
  case "$compact" in *"\"version\":\"${expected}\""*) ;; *) die "health version is not ${expected}" ;; esac
fi

docker logs "$name" 2>&1 | grep -q 'Applied migrations:' || die "no 'Applied migrations:' line: migrations did not run on the fresh database"

uid="$(docker exec "$name" id -u)"
[ "$uid" != 0 ] || die "container runs as root"

code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/")"
[ "$code" = 200 ] || die "web UI answered ${code} at /, expected 200"

echo "Smoke test passed for ${image}."
