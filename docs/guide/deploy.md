# Deploy

Use this when Agent Office is a git checkout supervised by systemd. npm, Homebrew, and Docker upgrades are [upgrading.md](upgrading.md). They do not use this layout.

Keep each release in its own directory and point the running units at a `current` symlink. Replacing the symlink is the cut-over. The data directory and the env file stay where they are.

```
~/agent-office-releases/<full-sha>/
~/agent-office-releases/current  →  that directory
```

Two user units, both stopped until the first deploy starts them:

| Unit | Program | Notes |
| --- | --- | --- |
| API | `node <releases>/current/server.js` | `AO_API_ONLY=1`. `EnvironmentFile` is the mode-600 env file. |
| Web | `node <releases>/current/scripts/serve-frontend.js` | UI at `/`, API base `/backend`. |

`WorkingDirectory` is the same `current` path. `ExecStart` uses that path too, including the trailing slash of the symlink (`…/current/server.js`), so a reload does not pin a single SHA. After editing the units, `systemctl --user daemon-reload`. Do not `enable` or `start` them in that step.

The env file needs `OC_GATEWAY_TOKEN`, `PORTAL_EMAIL`, `PORTAL_SECRET`, and `PORTAL_PASSWORD_HASH` (`agent-office hash-password`). `agent-office check-config --env-file <file>` prints `ok` or `missing` and does not print values. If a key is missing, do not move `current`.

`current` has to exist before the first deploy (an older checkout is enough) so a failure can switch it back. The tool refuses to switch if that symlink is missing or dangling. A deploy holds `flock` on the releases lock file; the kernel releases that lock when the holder dies, and the file is not a pid. Each build and install step runs as a transient user unit `ao-deploy-<sha>-<step>` with `KillMode=control-group`. Stopping that unit stops the step and its descendants. The journal records the unit name and the last known-good commit, not a worker pid, and a failed retry switches back to that release rather than to one that did not verify. The tree is exported with `git archive` into the final directory, a `REVISION` file records the commit and a hash of that tree, and the directory is made read-only before the symlink switches. A later activation checks the hash and a manifest. Smoke output is not printed: the login password goes through a mode-0600 file the smoke reads itself, and the deploy prints the step name and the exit status.

## Steps

From the repository that contains the commit:

```sh
mkdir -p ~/agent-office-releases/<sha>
git -C <repo> archive --format=tar <sha> | tar -x -C ~/agent-office-releases/<sha>
cd ~/agent-office-releases/<sha>
npm ci --omit=dev
node scripts/build-frontend.js
node --check server.js
node --check gateway.js
node --check scripts/serve-frontend.js
node packaging/bin/agent-office.js check-config --env-file ~/.config/agent-office.env
```

Run `node scripts/build-frontend.js` after the last source, contract or design change when cutting a release. It syncs the runtime design/examples, regenerates the browser VM schemas, then stamps the complete UI with one content build ID (`?v=`), import map and route preloads. Run tests and copy/package the release after this command; rerun it if any of those inputs change. It does not start services or deploy.

The deploy writes `REVISION` (commit, then tree hash) and checks it again before activation. `chmod -R a-w` runs before the symlink moves.

Point the reverse proxy at the API and web ports before the smoke. The smoke calls the public origin. If the proxy still serves the previous process, the smoke does not certify this release. Do not restart the OpenClaw gateway. Do not edit the proxy from the deploy itself.

Switch the symlink, then restart only the two units (API first):

```sh
ln -s ~/agent-office-releases/<sha> ~/agent-office-releases/.next
mv -Tf ~/agent-office-releases/.next ~/agent-office-releases/current
systemctl --user restart <api-unit>
systemctl --user restart <web-unit>
```

Wait until `GET /` and `GET /backend/api/v2/meta` on the public origin are both 200. Then:

```sh
scripts/golive-smoke.sh https://example.invalid
```

`API_BASE` defaults to `/backend`. `PORTAL_EMAIL` comes from the env file. `PORTAL_PASSWORD` does not: a hash-only file has no plaintext password. Pass `AO_SMOKE_PASSWORD` for this run, or type it when the deploy has a terminal. It is not printed and not saved. The session cookie stays in a mode-600 jar. On `https` the cookie must be `Secure` and `HttpOnly`. `--readonly` expects mute to be HTTP 403; otherwise the script mutes one issue and unmutes it.

## Security headers

The web unit (`scripts/serve-frontend.js`) already sends these on every response, so a plain reverse proxy needs nothing more:

| Header | Value |
| --- | --- |
| `Content-Security-Policy` | `default-src 'self'`; `script-src 'self'` plus the import map's hash; `style-src 'self'`; `img-src 'self' data: blob: https:`; `font-src`, `connect-src`, `manifest-src`, `worker-src 'self'`; `object-src 'none'`; `frame-ancestors 'none'`; `base-uri 'self'`; `form-action 'self'` |
| `Strict-Transport-Security` | `max-age=31536000`, only over HTTPS: TLS on the socket, or `X-Forwarded-Proto: https` from a proxy the web unit trusts (`AO_TRUST_PROXY`, same syntax as the API: `loopback` by default, then addresses or CIDR ranges) |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `X-Frame-Options` | `DENY` (older browsers; `frame-ancestors` is the modern form) |

Behind a proxy that isn't on loopback (Traefik in Docker reaches the host from its network, e.g. `172.30.0.0/16`), give the web unit the same `AO_TRUST_PROXY` as the API, or it ignores the proxy's `X-Forwarded-Proto` and sends no HSTS. Setting `stsSeconds` in the Traefik middleware below also works.

There is no `unsafe-inline` and no `unsafe-eval`. The only inline script is the import map, allowed by its SHA-256. The UI loads fonts and assets from its own origin. Images are the one exception: project thumbnails (GitHub OpenGraph cards, site screenshots) and avatars are public `https` URLs by contract. `base-uri` is `'self'` rather than `'none'` because the page's `<base href>` carries its mount point.

Print the exact values for the release you are deploying (the CSP hash changes when the import map does):

```sh
node scripts/serve-frontend.js --print-headers
```

To set the same headers at the edge (or when something other than `serve-frontend.js` serves the UI), use a Traefik headers middleware on the web router. Paste the CSP from `--print-headers`:

```yaml
http:
  middlewares:
    agent-office-headers:
      headers:
        contentSecurityPolicy: "<Content-Security-Policy from --print-headers>"
        stsSeconds: 31536000          # Traefik sends it on TLS requests only
        contentTypeNosniff: true
        referrerPolicy: "strict-origin-when-cross-origin"
        permissionsPolicy: "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()"
        frameDeny: true
        customResponseHeaders:
          Cross-Origin-Opener-Policy: "same-origin"
  routers:
    agent-office-web:
      # … existing rule, entryPoints, tls and service …
      middlewares:
        - agent-office-headers
```

If both the edge and the web unit send a CSP, the browser enforces both, so a stale hash at the edge blocks the page. Regenerate the value on each release, or leave `contentSecurityPolicy` out of the middleware and let the web unit send it. The API routes (`/backend`) answer JSON and need no CSP; the other headers are harmless there.

## When smoke fails

Point `current` back at the previous directory and restart those same two units. Do not restore the proxy in that step, and do not start or stop any other service. Keep the newest three recorded releases for each target. Do not delete a directory that either symlink or a running unit's `WorkingDirectory` still resolves to. Resolve those paths before any removal.

`scripts/deploy.sh --target prod <sha>` (which runs `node scripts/deploy.js`) is this host's copy of the steps above (its unit names, env file, and public origin). `--target rehearsal` is that host's rehearsal only. The cut-over checklist is [docs/architecture/go-live.md](../architecture/go-live.md).
