#!/bin/sh
# Public go-live smoke (docs/architecture/go-live.md §D, plus meta env, health, and the API-root 404).
#   scripts/golive-smoke.sh [--readonly] BASE_URL [API_BASE]
# BASE_URL is the UI origin (GET / is HTML). API_BASE defaults to /backend, the one-port
# and public topology. Pass another prefix when the API is mounted elsewhere.
# Credentials: PORTAL_EMAIL and PORTAL_PASSWORD in the environment, or in the
# mode-0600 file named by AO_SMOKE_FILE (KEY=value, no shell expansion). They are not printed.
# The session cookie stays in a mode-600 jar under a private temp dir. It is not a curl argument.
# --readonly: mute and unmute must be refused with HTTP 403 and error code readonly (no store write).
# Exits on the first failure. Messages name the check and the HTTP status only.
set -eu

fail() { printf 'fail: %s\n' "$1" >&2; exit 1; }
ok() { printf 'ok: %s\n' "$1"; }

READONLY=0
BASE=''
API_BASE=''
API_BASE_SET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --readonly) READONLY=1 ;;
    --help|-h)
      printf '%s\n' 'usage: golive-smoke.sh [--readonly] BASE_URL [API_BASE]'
      printf '%s\n' 'API_BASE defaults to /backend'
      exit 0
      ;;
    -*) fail "unknown option: $1" ;;
    *)
      if [ -z "$BASE" ]; then BASE=$1
      elif [ "$API_BASE_SET" = 0 ]; then API_BASE=$1; API_BASE_SET=1
      else fail 'too many arguments'
      fi
      ;;
  esac
  shift
done
[ -n "$BASE" ] || fail 'usage: golive-smoke.sh [--readonly] BASE_URL [API_BASE]'
if [ "$API_BASE_SET" = 0 ]; then API_BASE=/backend; fi
case "$API_BASE" in
  /*) ;;
  *) fail 'API_BASE must start with /' ;;
esac
BASE=${BASE%/}
API="$BASE${API_BASE%/}"

umask 077
TMP=$(mktemp -d)
: > "$TMP/cookies"
chmod 600 "$TMP/cookies"
MUTATED=0
RESTORED=1
ISSUE_ID=''
ISSUE_WAS=''
LOGGED_OUT=0
LOGGED_IN=0

restore_issue() {
  # Back to the state recorded before this script muted anything. Retries a transient refusal.
  [ "$MUTATED" = 1 ] || return 0
  [ "$RESTORED" = 1 ] && return 0
  target=false
  [ "$ISSUE_WAS" = 'muted' ] && target=true
  n=0
  while [ "$n" -lt 3 ]; do
    code=$(MUTE_SOFT=1 put_mute "$ISSUE_ID" "$target" || true)
    if is_2xx "$code"; then
      RESTORED=1
      return 0
    fi
    n=$((n + 1))
  done
  return 1
}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ "$MUTATED" = 1 ] && [ "$RESTORED" != 1 ]; then
    if ! restore_issue; then
      if [ "$ISSUE_WAS" = 'muted' ]; then
        printf 'fail: issue %s left unmuted\n' "$ISSUE_ID" >&2
      else
        printf 'fail: issue %s left muted\n' "$ISSUE_ID" >&2
      fi
      status=1
    fi
  fi
  if [ "$LOGGED_IN" = 1 ] && [ "$LOGGED_OUT" != 1 ]; then
    curl -sS --max-time 5 -b "$TMP/cookies" -c "$TMP/cookies" -o /dev/null -X POST \
      -H 'content-type: application/json' -H 'X-AO-Request: 1' --data-binary '{}' \
      "$API/api/logout" || true
    LOGGED_OUT=1
  fi
  rm -rf "$TMP"
  exit "$status"
}
trap cleanup EXIT INT TERM

if [ -n "${AO_SMOKE_FILE:-}" ]; then
  [ -f "$AO_SMOKE_FILE" ] || fail 'smoke credential file is missing'
  cat > "$TMP/load-smoke.js" <<'EOF'
const fs = require('fs');
const text = fs.readFileSync(process.argv[2], 'utf8');
const sh = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";
for (const line of text.split('\n')) {
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq < 1) continue;
  const key = line.slice(0, eq);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
  process.stdout.write('export ' + key + '=' + sh(line.slice(eq + 1)) + '\n');
}
EOF
  # shellcheck disable=SC1090
  eval "$(node "$TMP/load-smoke.js" "$AO_SMOKE_FILE")"
fi

[ -n "${PORTAL_EMAIL:-}" ] && [ -n "${PORTAL_PASSWORD:-}" ] || fail 'PORTAL_EMAIL and PORTAL_PASSWORD must be set'

# argv: file. Prints one line, or exits 1. Never prints credentials or the cookie.
json() { node "$TMP/smoke.js" "$TMP" "$@"; }

cat > "$TMP/smoke.js" <<'EOF'
'use strict';
const fs = require('fs');
const http = require('http');
const https = require('https');
const dir = process.argv[2];
const cmd = process.argv[3];
const read = (name) => fs.readFileSync(dir + '/' + name, 'utf8');
const json = (name) => JSON.parse(read(name));
function out(line) { process.stdout.write(String(line) + '\n'); }
if (cmd === 'login-body') {
  fs.writeFileSync(dir + '/login.json', JSON.stringify({
    email: process.env.PORTAL_EMAIL, password: process.env.PORTAL_PASSWORD,
  }), { mode: 0o600 });
} else if (cmd === 'status') {
  const hdr = read(process.argv[4]);
  const m = hdr.match(/^HTTP\/\d+(?:\.\d+)?\s+(\d+)/m);
  if (!m) process.exit(2);
  out(m[1]);
} else if (cmd === 'cookie') {
  const hdr = read('login.hdr');
  const line = hdr.split(/\r?\n/).find((l) => /^set-cookie:\s*taco_sess=/i.test(l));
  if (!line) process.exit(2);
  const parts = line.replace(/^set-cookie:\s*/i, '').split(';').map((s) => s.trim()).filter(Boolean);
  fs.writeFileSync(dir + '/cookie', parts[0], { mode: 0o600 });
  const flags = parts.slice(1).map((s) => s.split('=')[0].toLowerCase());
  out(flags.includes('httponly') ? 'httponly' : 'no-httponly');
  out(flags.includes('secure') ? 'secure' : 'no-secure');
} else if (cmd === 'meta-env') {
  const data = json('meta.json').data || {};
  if (data.env !== 'production' && data.env !== 'staging' && data.env !== 'dev') process.exit(2);
  const caps = data.capabilities || {};
  out(data.env + ' storeWrites=' + (caps.storeWrites === true) + ' openclawWrites=' + (caps.openclawWrites === true));
} else if (cmd === 'health-ok') {
  const data = json('health.json').data;
  if (!data || typeof data.level !== 'string') process.exit(2);
} else if (cmd === 'issue') {
  // api.md §5.3: :id is the fingerprint. An error issue is not a mute target (400).
  const data = json('health.json').data || {};
  const issues = (data.dataQuality && data.dataQuality.issues) || [];
  const issue = issues.find((i) => i && i.id && i.severity !== 'error');
  if (!issue) process.exit(0);
  out(issue.id);
  out(issue.state === 'muted' ? 'muted' : 'open');
} else if (cmd === 'error-code') {
  const body = json(process.argv[4]);
  const code = body && body.error && body.error.code;
  if (!code) process.exit(2);
  out(code);
} else if (cmd === 'html') {
  const type = read('page.hdr');
  const body = read('page.body');
  if (!/^content-type:\s*text\/html\b/im.test(type)) process.exit(2);
  if (!/<\s*!doctype\s+html|<\s*html[\s>]/i.test(body)) process.exit(2);
} else if (cmd === 'sse') {
  // Cookie is read from the login header file, not from argv. The deadline covers
  // connect, TLS, and response headers, not only the body after headers arrive.
  const cookie = read('cookie').trim();
  const url = new URL(process.argv[4]);
  const lib = url.protocol === 'https:' ? https : http;
  let req;
  let settled = false;
  const finish = (code, line) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (line) out(line);
    try { req.destroy(); } catch (_) {}
    process.exit(code);
  };
  const timer = setTimeout(() => finish(3, 'timeout'), 10000);
  req = lib.request(url, {
    headers: { cookie, accept: 'text/event-stream' },
  }, (res) => {
    if (res.statusCode !== 200) { finish(2, 'HTTP ' + res.statusCode); return; }
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const m = buf.match(/^event:\s*(\S+)/m);
      if (!m) return;
      finish(0, m[1]);
    });
    res.on('end', () => { if (!settled && !/^event:/m.test(buf)) finish(3, 'closed'); });
  });
  req.on('error', (err) => {
    if (settled) return;
    if (err && err.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
    finish(4, 'error');
  });
  req.end();
} else process.exit(2);
EOF

json login-body

http_code() {
  json status "$1"
}

is_2xx() { case "$1" in 2[0-9][0-9]) return 0 ;; *) return 1 ;; esac; }

request() {
  # request OUT STATUS_VAR method url [extra curl args...]
  # MUTE_SOFT=1: a transport failure sets status 000 instead of exiting.
  out=$1 status_var=$2 method=$3 url=$4
  shift 4
  : > "$TMP/$out.hdr"
  if ! curl -sS --max-time 20 -b "$TMP/cookies" -c "$TMP/cookies" -D "$TMP/$out.hdr" -o "$TMP/$out.body" -X "$method" "$@" "$url"; then
    if [ "${MUTE_SOFT:-0}" = 1 ]; then
      eval "$status_var=000"
      return 0
    fi
    fail "$out request failed"
  fi
  code=$(http_code "$out.hdr") || {
    if [ "${MUTE_SOFT:-0}" = 1 ]; then eval "$status_var=000"; return 0; fi
    fail "$out has no HTTP status"
  }
  eval "$status_var=\$code"
}

# 1. GET / is HTML
request page page_code GET "$BASE/"
[ "$page_code" = 200 ] || fail "GET / expected HTML, got HTTP $page_code"
json html || fail "GET / is not HTML"
ok 'GET / HTML'

# 2. API meta env
request meta meta_code GET "$API/api/v2/meta"
[ "$meta_code" = 200 ] || fail "meta HTTP $meta_code"
mv "$TMP/meta.body" "$TMP/meta.json"
env_name=$(json meta-env) || fail 'meta env missing'
ok "meta $env_name"

# 3–4. Login. Cookie flags are required only on https. The jar, not -H, holds the cookie.
request login login_code POST "$API/api/login" \
  -H 'content-type: application/json' -H 'X-AO-Request: 1' --data-binary @"$TMP/login.json"
rm -f "$TMP/login.json"
chmod 600 "$TMP/cookies"
[ "$login_code" = 200 ] || fail "login HTTP $login_code"
cookie_flags=$(json cookie) || fail 'login did not set taco_sess'
LOGGED_IN=1
ok 'login'
case "$BASE" in
  https:*)
    printf '%s\n' "$cookie_flags" | grep -q '^httponly$' || fail 'cookie is not HttpOnly'
    printf '%s\n' "$cookie_flags" | grep -q '^secure$' || fail 'cookie is not Secure'
    ok 'cookie Secure HttpOnly'
    ;;
  *)
    ok 'cookie (HTTP, Secure not required)'
    ;;
esac

# 5. Health
request health health_code GET "$API/api/v2/views/health"
[ "$health_code" = 200 ] || fail "health HTTP $health_code"
mv "$TMP/health.body" "$TMP/health.json"
json health-ok || fail 'health has no level'
ok 'health'

# 6. SSE first event within 10s, including connect and headers
sse_event=$(json sse "$API/api/v2/stream?topics=health") || fail 'SSE first event did not arrive within 10s'
ok "SSE event=$sse_event"

put_mute() {
  # put_mute ID BOOL -> prints HTTP status; body in mute.body
  id=$1 muted=$2
  enc=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$id")
  MUTE_SOFT="${MUTE_SOFT:-0}" request mute mute_code PUT "$API/api/v2/health/issues/$enc/muted" \
    -H 'content-type: application/json' -H 'X-AO-Request: 1' \
    --data-binary "{\"muted\":$muted}"
  mv "$TMP/mute.body" "$TMP/mute.json" 2>/dev/null || true
  MUTE_SOFT=0
  printf '%s' "$mute_code"
}

# 7. Mute the first non-error issue (§5.3), or notice when there is none.
issue=$(json issue || true)
id=$(printf '%s\n' "$issue" | sed -n '1p')
was=$(printf '%s\n' "$issue" | sed -n '2p')
if [ -z "$id" ]; then
  printf '%s\n' 'notice: no issue to mute'
elif [ "$READONLY" = 1 ]; then
  code=$(put_mute "$id" true)
  if is_2xx "$code"; then
    ISSUE_ID=$id
    ISSUE_WAS=$was
    MUTATED=1
    RESTORED=0
    restore_issue || true
    fail "mute expected 403, got HTTP $code"
  fi
  [ "$code" = 403 ] || fail "mute expected 403, got HTTP $code"
  mcode=$(json error-code mute.json) || fail 'mute 403 has no error code'
  [ "$mcode" = 'readonly' ] || fail "mute expected readonly, got $mcode"
  ok 'mute refused'
else
  ISSUE_ID=$id
  ISSUE_WAS=$was
  code=$(put_mute "$id" true)
  is_2xx "$code" || fail "mute HTTP $code"
  MUTATED=1
  RESTORED=0
  # Unmute, retrying a transient refusal. Then put an originally muted issue back.
  n=0
  unmuted=0
  while [ "$n" -lt 3 ]; do
    code=$(put_mute "$id" false)
    if is_2xx "$code"; then unmuted=1; break; fi
    n=$((n + 1))
  done
  if [ "$unmuted" != 1 ]; then
    if [ "$was" = 'muted' ]; then
      RESTORED=1
      fail "unmute HTTP $code"
    fi
    RESTORED=1
    printf 'fail: issue %s left muted\n' "$id" >&2
    exit 1
  fi
  if [ "$was" = 'muted' ]; then
    n=0
    remuted=0
    while [ "$n" -lt 3 ]; do
      code=$(put_mute "$id" true)
      if is_2xx "$code"; then remuted=1; break; fi
      n=$((n + 1))
    done
    if [ "$remuted" != 1 ]; then
      RESTORED=1
      printf 'fail: issue %s left unmuted\n' "$id" >&2
      exit 1
    fi
  fi
  RESTORED=1
  ok 'mute and unmute'
fi

# 8. Logout, then the old cookie is 401
request logout logout_code POST "$API/api/logout" \
  -H 'content-type: application/json' -H 'X-AO-Request: 1' \
  --data-binary '{}'
[ "$logout_code" = 200 ] || fail "logout HTTP $logout_code"
LOGGED_OUT=1
request after after_code GET "$API/api/v2/me"
[ "$after_code" = 401 ] || fail "request after logout HTTP $after_code"
ok 'logout then 401'

# 9. API root is the v2 JSON 404
request root root_code GET "$API/"
[ "$root_code" = 404 ] || fail "API root expected 404, got HTTP $root_code"
mv "$TMP/root.body" "$TMP/root.json"
rcode=$(json error-code root.json) || fail 'API root is not JSON'
[ "$rcode" = 'not_found' ] || fail "API root error code is $rcode"
ok 'API root 404 JSON'

ok 'golive-smoke'
