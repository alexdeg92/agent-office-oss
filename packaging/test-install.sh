#!/bin/sh
# Local check of the three install methods. Publishes nothing.
#   packaging/test-install.sh
set -eu
cd "$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"

version=$(node -e 'process.stdout.write(require("./package.json").version)')
secret='demo-session-secret'
stage=$(mktemp -d)
prefix=$(mktemp -d)
data=''
pid=''
task_home="$stage/home"
mkdir -p "$task_home"
trap 'if [ -n "$pid" ]; then kill -TERM "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi; rm -rf "$stage" "$prefix" "$data"' EXIT INT TERM

node scripts/build-frontend.js
node -e 'require("./packaging/release-tools").stagePackage(process.cwd(), process.argv[1])' "$stage"
( cd "$stage" && npm pack --pack-destination "$stage" >/dev/null )
tarball="${stage}/alexdeg92-agent-office-${version}.tgz"
test -f "$tarball"
tar -tzf "$tarball" | grep -q 'package/public/v2/bureau/bureau.css'
npm install -g --prefix "$prefix" "$tarball" >/dev/null

got=$("$prefix/bin/agent-office" --version | tr -d '\r')
if [ "$got" != "$version" ]; then
  printf 'test-install: version is %s, expected %s\n' "$got" "$version" >&2
  exit 1
fi
"$prefix/bin/agent-office" setup --help > "$stage/setup-help.txt"
node - "$prefix/lib/node_modules/@alexdeg92/agent-office" "$stage" <<'JS'
const path = require('node:path');
const integration = require(path.join(process.argv[2], 'src/adapters/openclaw/integration'));
const expected = integration.expected(process.argv[3], 'en');
if (!expected.files['projet.js'] || !expected.files['SKILL.md']) process.exit(1);
JS
cfg=$(
  HOME="$task_home" OC_HOME="$task_home" OC_BIN="$task_home/missing-openclaw" \
  OC_GATEWAY_URL=ws://127.0.0.1:9 \
  OC_GATEWAY_TOKEN=demo-gateway-token \
  PORTAL_EMAIL=demo@example.com \
  PORTAL_PASSWORD=demo-password \
  PORTAL_SECRET="$secret" \
  "$prefix/bin/agent-office" check-config
)
printf '%s\n' "$cfg" | grep -q 'PORTAL_SECRET: ok'
case "$cfg" in
  *"$secret"*|*'demo-gateway-token'*|*'demo-password'*|*'demo@example.com'*)
    printf '%s\n' 'test-install: check-config printed a demo value' >&2
    exit 1
    ;;
esac
data=$(mktemp -d)
port=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')
pid=''
cleanup() {
  if [ -n "$pid" ]; then
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$stage" "$prefix" "$data"
}
trap cleanup EXIT INT TERM
HOME="$task_home" OC_HOME="$task_home" OC_BIN="$task_home/missing-openclaw" \
OC_GATEWAY_URL=ws://127.0.0.1:9 \
OC_GATEWAY_TOKEN=demo-gateway-token \
PORTAL_EMAIL=demo@example.com \
PORTAL_PASSWORD=demo-password \
PORTAL_SECRET="$secret" \
"$prefix/bin/agent-office" start --host 127.0.0.1 --port "$port" --data "$data" >"$data/boot.log" 2>&1 &
pid=$!
i=0
code=000
while [ "$i" -lt 40 ]; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/backend/api/v2/meta" || true)
  [ "$code" = "200" ] && break
  if ! kill -0 "$pid" 2>/dev/null; then
    printf '%s\n' 'test-install: server exited before /backend/api/v2/meta' >&2
    exit 1
  fi
  i=$((i + 1))
  sleep 0.5
done
[ "$code" = "200" ] || {
  printf '%s\n' "test-install: GET /backend/api/v2/meta returned ${code}" >&2
  exit 1
}
ui=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/" || true)
[ "$ui" = "200" ] || {
  printf '%s\n' "test-install: GET / returned ${ui}" >&2
  exit 1
}
printf '%s\n' "test-install: npm ok (${version}, /backend/api/v2/meta 200)"

if command -v brew >/dev/null 2>&1; then
  brew audit --strict --formula packaging/homebrew/agent-office.rb
  printf '%s\n' 'test-install: brew audit ok'
else
  printf '%s\n' 'test-install: notice: brew is not installed; skipping brew audit'
fi

packaging/docker/smoke.sh
printf '%s\n' 'test-install: ok'
