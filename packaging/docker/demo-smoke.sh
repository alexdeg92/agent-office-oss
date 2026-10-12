#!/bin/sh
# Demo-adapter smoke. The image must already exist (CI builds agent-office:ci).
#   IMAGE=agent-office:ci packaging/docker/demo-smoke.sh
# Boots the default one-port start with AO_RUNTIME=demo and no gateway token.
# Checks the UI, meta (runtime id demo, primary Nova), a login, and that the
# office view changes after the demo's ticks. Throwaway values are not printed.
set -eu
cd "$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"

IMAGE="${IMAGE:-agent-office:local}"
NAME="agent-office-demo-$$"
EMAIL="you@example.com"
PASSWORD="choose-a-password"
SECRET="choose-a-long-secret"

fail() {
  printf 'demo-smoke: %s\n' "$1" >&2
  exit 1
}

IMAGE=$(docker image inspect --format '{{.Id}}' "$IMAGE") || fail "supplied image is missing"

cleanup() {
  docker rm -fv "$NAME" >/dev/null 2>&1 || true
  if [ -n "${TMP:-}" ]; then rm -rf "$TMP"; fi
}
trap cleanup EXIT INT TERM

docker run -d --name "$NAME" \
  -p 127.0.0.1::18789 \
  -e AO_RUNTIME=demo \
  -e PORTAL_COOKIE_SECURE=0 \
  -e PORTAL_EMAIL="$EMAIL" \
  -e PORTAL_PASSWORD="$PASSWORD" \
  -e PORTAL_SECRET="$SECRET" \
  "$IMAGE" >/dev/null

binding=$(docker port "$NAME" 18789/tcp)
case "$binding" in
  127.0.0.1:*) ;;
  *) fail "port is not on localhost (${binding})" ;;
esac
port=${binding##*:}
base="http://127.0.0.1:${port}"

umask 077
TMP=$(mktemp -d)
: > "$TMP/cookies"
chmod 600 "$TMP/cookies"

i=0
html=0
while [ "$i" -lt 40 ]; do
  if curl -fsS -o "$TMP/index.html" "$base/" 2>/dev/null && grep -q 'ao-config' "$TMP/index.html"; then html=1; break; fi
  if ! docker inspect -f '{{.State.Running}}' "$NAME" | grep -qx true; then
    fail "container exited before the UI was up"
  fi
  i=$((i + 1))
  sleep 1
done
[ "$html" = 1 ] || fail "GET / did not serve the UI"

i=0
meta_code=000
while [ "$i" -lt 40 ]; do
  meta_code=$(curl -sS -o "$TMP/meta.json" -w '%{http_code}' "$base/backend/api/v3/meta" 2>/dev/null || true)
  [ "$meta_code" = "200" ] && break
  i=$((i + 1))
  sleep 1
done
[ "$meta_code" = "200" ] || fail "GET /backend/api/v3/meta returned ${meta_code}"

node - "$TMP/meta.json" <<'JS' || fail "meta is not the demo team"
const fs = require('fs');
const body = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const data = body.data || {};
const runtime = data.runtime || {};
const primary = data.primaryAgent || {};
if (runtime.id !== 'demo') process.exit(1);
if (primary.id !== 'nova' || primary.name !== 'Nova') process.exit(1);
if (!data.instance || data.instance.configured !== true) process.exit(1);
if (data.readonly !== true) process.exit(1);
JS

login_code=$(curl -sS -o "$TMP/login.json" -w '%{http_code}' \
  -c "$TMP/cookies" \
  -H 'content-type: application/json' \
  -H 'X-AO-Request: 1' \
  --data-binary @- \
  "$base/backend/api/login" <<EOF
{"email":"${EMAIL}","password":"${PASSWORD}"}
EOF
)
[ "$login_code" = "200" ] || fail "login returned ${login_code}"
node - "$TMP/login.json" <<'JS' || fail "login body was not ok"
const fs = require('fs');
const body = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!body.ok) process.exit(1);
JS

office() {
  code=$(curl -sS -o "$TMP/office.json" -w '%{http_code}' -b "$TMP/cookies" "$base/backend/api/v2/views/office" || true)
  [ "$code" = "200" ] || fail "GET /backend/api/v2/views/office returned ${code}"
  node - "$TMP/office.json" <<'JS'
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).data || {};
const tokens = (data.kpis || []).find((k) => k.id === 'tokens');
if (!data.connection || data.connection.gateway !== 'up') process.exit(2);
if (!tokens || typeof tokens.value !== 'number') process.exit(3);
const occ = (data.occupants || []).map((o) => o.id + ':' + o.state + ':' + o.tokens).sort().join('|');
if (!occ) process.exit(4);
process.stdout.write(String(tokens.value) + '\n' + occ + '\n');
JS
}

first=$(office) || fail "office view was not live"
sleep 14
second=$(office) || fail "office view was not live after a tick"
[ "$first" != "$second" ] || fail "office view did not change after the demo tick"

logs=$(docker logs "$NAME" 2>&1 || true)
case "$logs" in
  *"$PASSWORD"*|*"$SECRET"*) fail "container logs printed a demo value" ;;
esac

printf 'demo-smoke: ok (%s, demo, nova, office moved)\n' "$IMAGE"
