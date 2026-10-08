#!/bin/sh
# Container smoke test. Builds the local image and does not push it.
#   packaging/docker/smoke.sh
# Demo environment values are fake. The script checks they are not printed.
set -eu
cd "$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"

IMAGE="${IMAGE:-agent-office:local}"
NAME="agent-office-smoke-$$"
DEMO_TOKEN="demo-gateway-token"
DEMO_EMAIL="demo@example.com"
DEMO_PASSWORD="demo-password"
DEMO_SECRET="demo-session-secret"

fail() {
  printf 'smoke: %s\n' "$1" >&2
  exit 1
}

docker build --provenance=false -f packaging/docker/Dockerfile -t "$IMAGE" .

expected=$(node -e 'process.stdout.write(require("./package.json").version)')
version=$(docker run --rm "$IMAGE" version | tr -d '\r')
printf '%s\n' "$version" | grep -qx "$expected" || fail "version printed: ${version} (expected ${expected})"

config=$(docker run --rm \
  -e OC_GATEWAY_TOKEN="$DEMO_TOKEN" \
  -e PORTAL_EMAIL="$DEMO_EMAIL" \
  -e PORTAL_PASSWORD="$DEMO_PASSWORD" \
  -e PORTAL_SECRET="$DEMO_SECRET" \
  "$IMAGE" check-config)
printf '%s\n' "$config" | grep -q 'OC_GATEWAY_TOKEN: ok' || fail "check-config did not see the gateway token"
printf '%s\n' "$config" | grep -q 'PORTAL_SECRET: ok' || fail "check-config did not see the session secret"
case "$config" in
  *"$DEMO_TOKEN"*|*"$DEMO_EMAIL"*|*"$DEMO_PASSWORD"*|*"$DEMO_SECRET"*)
    fail "check-config printed a demo value"
    ;;
esac

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run -d --name "$NAME" \
  -p 127.0.0.1::18789 \
  -e OC_GATEWAY_TOKEN="$DEMO_TOKEN" \
  -e PORTAL_EMAIL="$DEMO_EMAIL" \
  -e PORTAL_PASSWORD="$DEMO_PASSWORD" \
  -e PORTAL_SECRET="$DEMO_SECRET" \
  "$IMAGE" start --api-only >/dev/null

uid=$(docker exec "$NAME" id -u)
[ "$uid" = "10001" ] || fail "uid is ${uid}"

binding=$(docker port "$NAME" 18789/tcp)
case "$binding" in
  127.0.0.1:*) ;;
  *) fail "API port is not on localhost (${binding})" ;;
esac
port=${binding##*:}

i=0
code=000
while [ "$i" -lt 40 ]; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/api/v2/meta" || true)
  [ "$code" = "200" ] && break
  i=$((i + 1))
  sleep 1
done
[ "$code" = "200" ] || fail "GET /api/v2/meta returned ${code}"

i=0
health=none
while [ "$i" -lt 40 ]; do
  health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$NAME")
  [ "$health" = "healthy" ] && break
  i=$((i + 1))
  sleep 3
done
[ "$health" = "healthy" ] || fail "HEALTHCHECK status is ${health}"

if ! docker run --rm --entrypoint node "$IMAGE" -e "process.exit((require('fs').existsSync('public/app.js')||require('fs').existsSync('public/index.html'))?2:0)"; then
  fail "legacy public UI is in the image"
fi

printf 'smoke: ok (version %s, meta 200, %s, uid %s, 127.0.0.1:%s)\n' "$version" "$health" "$uid" "$port"
