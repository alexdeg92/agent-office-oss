# Install

Pick one method. A default install is one process: the UI at `/` and the API at `/backend`, on port 18789. A production reverse proxy can still split them (`agent-office start --api-only` listens at `/api`, and `agent-office web` is the UI alone).

Secrets stay in the environment. They are not part of the npm package, the Homebrew formula, or the image. The instance config file holds no secrets; see [config.md](config.md).

None of the three is published yet. npmjs, the GitHub tap, and a container registry each need a login and an explicit approval.

| | npm | Homebrew | Docker |
| --- | --- | --- | --- |
| Install | `npm i -g @alexdeg92/agent-office` | `brew install alexdeg92/tap/agent-office` | `docker compose -f packaging/docker/compose.yml up --build` |
| One-shot | `npx @alexdeg92/agent-office` | — | — |
| Run | `agent-office start` (UI `/`, API `/backend`, port 18789) | `brew services start agent-office` | `docker compose up` (same one-port process) |
| Split | `start --api-only` and `web` | — | set `AO_API_ONLY=1` and run `web` behind a proxy |
| Needs | Node.js 24+ | Homebrew and Node (the formula depends on `node`) | Docker Engine with Compose v2 |

For a first install, run `agent-office setup` and follow the browser wizard. It persists configuration and secrets locally. For an environment-managed OpenClaw install, the required names are: `OC_GATEWAY_TOKEN`, `PORTAL_EMAIL`, `PORTAL_PASSWORD_HASH`, `PORTAL_SECRET`. Copy `.env.example` to a mode-`600` file and fill it in. Do not commit that file. npm and npx do not read that file on their own: pass `--env-file` (a variable already set in the environment wins; values are not printed). Homebrew's service script sources `~/.config/agent-office.env` or `AO_ENV_FILE`. Docker Compose uses `env_file`; a bare `docker run` needs `--env-file`.

## Try it without OpenClaw

`AO_RUNTIME=demo` selects the synthesised team ([adapters.md](adapters.md)). No gateway URL, no gateway token, and no runtime binary. You still choose a login. These values are for a local try; a kept install uses `PORTAL_PASSWORD_HASH` and an env file, not a password in the shell.

The Docker image sets `NODE_ENV=production`, so the session cookie is `Secure` unless `PORTAL_COOKIE_SECURE=0`. Set that for `http://127.0.0.1:18789/`. The interface is in French by default. Runtime writes stay off. The office, journal, and flows still move: the demo advances on its own every few seconds.

Build the local image once, then this is the run:

```sh
docker run --rm -p 127.0.0.1:18789:18789 -e AO_RUNTIME=demo -e PORTAL_COOKIE_SECURE=0 -e PORTAL_EMAIL=you@example.com -e PORTAL_PASSWORD=choose-a-password -e PORTAL_SECRET=choose-a-long-secret agent-office:local
```

The same start with npx, once the package is published:

```sh
AO_RUNTIME=demo PORTAL_COOKIE_SECURE=0 PORTAL_EMAIL=you@example.com PORTAL_PASSWORD=choose-a-password PORTAL_SECRET=choose-a-long-secret npx @alexdeg92/agent-office start
```

From a checkout, before that publish, `node packaging/bin/agent-office.js start` with the same variables is the same process. Open `http://127.0.0.1:18789/`. The API is `http://127.0.0.1:18789/backend/api/v3/meta` (`runtime.id` is `demo`).

`agent-office hash-password` prints the scrypt line for `PORTAL_PASSWORD_HASH`. On a terminal it asks twice and does not echo; otherwise it reads stdin. It does not take the password as an argument or from the environment, and it prints only the hash.

`AO_PUBLIC_URL` is the origin people type in the browser, `scheme://host[:port]` with no path. Set it when people browse anything other than loopback. A one-port install bound to loopback, with no `AO_PUBLIC_URL`, allows cookie writes whose Origin is the loopback Host the browser used (`localhost`, `127.0.0.1`, or `::1` on the listen port). The internal proxy records each client's socket address in `X-Forwarded-For`, and the API trusts only that loopback hop.

Once it is running, how to use the app is [Using Agent Office](user-guide.en.md) and [Utiliser Agent Office](user-guide.fr.md). Replacing a running install is [upgrading.md](upgrading.md). A gateway that never connects, a 429 on login, a data directory that refuses to start, or a 403 on a write is [troubleshooting.md](troubleshooting.md).

## npm

From a published package:

```sh
npm i -g @alexdeg92/agent-office
agent-office check-config --env-file ~/.config/agent-office.env
agent-office start --data ./data --env-file ~/.config/agent-office.env
```

Open `http://127.0.0.1:18789/`. The API is `http://127.0.0.1:18789/backend/api/v2/meta`. `npx @alexdeg92/agent-office check-config --env-file ~/.config/agent-office.env` and `npx @alexdeg92/agent-office start --env-file ~/.config/agent-office.env` do the same. `npx @alexdeg92/agent-office start --api-only --env-file ~/.config/agent-office.env` is the API alone. `npx @alexdeg92/agent-office web` is the UI alone.

There is no `postinstall`. The published tarball is `npm pack` after `node scripts/build-frontend.js`, staged outside the git checkout so the gitignored design bundle and `README.md` are included. The manifest declares public access and the MIT licence. The package does not include tests, design sources, or env files.

The `agent-office` bin is `packaging/bin/agent-office.js`. A checkout can run that file directly.

`check-config` prints `ok` or `missing` for each key and never prints values or paths. `--config` and `--data` are the paths it checks.

## Homebrew

The tap repository is `alexdeg92/homebrew-tap`. How that repo is laid out, and how the formula chooses the npm tarball or the GitHub release tarball, is [packaging/homebrew/README.md](../../packaging/homebrew/README.md).

```sh
brew tap alexdeg92/tap
brew install alexdeg92/tap/agent-office
agent-office check-config
brew services start agent-office
brew services stop agent-office
```

`brew services` runs `agent-office-service`, which execs `agent-office start` on `127.0.0.1:18789` (UI at `/`, API at `/backend`). The data directory is Homebrew's `var/lib/agent-office` unless `AO_DATA_DIR` is set. If `~/.config/agent-office.env` (or `AO_ENV_FILE`) exists, the service script sources it and does not print it.

## Docker

From a checkout of this repository:

```sh
cp .env.example .env
chmod 600 .env
# edit .env; do not commit it
docker compose -f packaging/docker/compose.yml up --build
```

`packaging/docker/docker-compose.example.yml` is that same one-port service with the image healthcheck written out (`/healthz`, then `/backend/healthz`). Its Traefik labels are commented. Uncomment them, and the external `proxy` network, only when Traefik is already routing this host. The Traefik readiness path is `GET /readyz`. Do not compress `text/event-stream`.

The image entrypoint is the CLI. A bare `docker run` is the one-port start (UI at `/`, API at `/backend`). `start --api-only` is the API alone. Subcommands are arguments:

```sh
docker run --rm agent-office:local version
docker run --rm --env-file .env agent-office:local check-config
docker run --rm --env-file .env -p 127.0.0.1::18789 agent-office:local start --api-only
```

`packaging/docker/smoke.sh` builds the local image and checks that path: `version`, `check-config` with a demo environment (values are not printed), `start --api-only` on a random localhost port, `GET /api/v2/meta` returns 200, the image health check becomes healthy, and the process uid is 10001. It does not push the image.

The image is `node:24-slim`, multi-stage. The build runs `node scripts/build-frontend.js`, then drops the design sources. The process runs as uid 10001. `NODE_ENV=production`. Volumes are `/data` (the store) and `/config` (the instance config file, when that exists). Nothing in the Dockerfile sets a token, password, or email.

Compose runs that one process and publishes `127.0.0.1:18789`. The image health check accepts `GET /healthz` or `GET /backend/healthz`. Neither response contains secrets. The image does not contain `public/app.js` or the rest of the legacy UI.

The runtime gateway is not in the image. Point `OC_GATEWAY_URL` at it (from a container on the same host, `ws://host.docker.internal:18793`). CLI-backed features need the runtime binary and its home mounted read-only; without them those capabilities stay off.

Do not push the image. Tag and publish are an operator step after approval.

### Reverse proxy

Compose includes a commented Traefik example and a commented Caddy example. Both match the topology:

- `/` → the web service (port 8080)
- `/backend` → the API, prefix stripped (port 18789)

Do not compress or buffer `text/event-stream`. The live stream is `/backend/api/v2/stream`.

## Check an install, then cut a release

`packaging/test-install.sh` checks the three methods on this machine: it installs the packed tarball into a temporary prefix and runs `version` and `check-config`, runs `brew audit` when Homebrew is installed (otherwise it prints a notice and continues), then runs `packaging/docker/smoke.sh`.

`packaging/release.sh --version X.Y.Z` prepares a release and stops there. It requires a clean git tree and green `npm run test:release` and packaged first-run checks, sets the version without a git tag, exports the public tree with the privacy gate, prepares `dist/homebrew-tap`, packs the tarball (including the design bundle), writes its sha256, updates the Homebrew formula's scoped npm URL and checksum, tags `agent-office:X.Y.Z`, and writes `dist/RELEASE_NOTES.md` from `CHANGELOG.md`. It does not run `npm publish`, `git push`, `docker push`, or `gh release`. It prints those commands for an operator to run later. Artifacts under `dist/` are gitignored.

Upgrading a running install is [upgrading.md](upgrading.md). How a runtime connects is [adapters.md](adapters.md). What still has to be true before a public release is [readiness.md](readiness.md).

