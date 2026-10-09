# Install

Pick one method. A default install is one process: the UI at `/` and the API at `/backend`, on port 18789. A production reverse proxy can still split them (`agent-office start --api-only` listens at `/api`, and `agent-office web` is the UI alone).

Secrets stay in private env/config files and the local database. They are not part of the npm package, the Homebrew formula, or the image. The instance config file holds no secrets; see [config.md](config.md).

Version 1.0.0 is published on [npm](https://www.npmjs.com/package/@alexdeg92/agent-office), in the [Homebrew tap](https://github.com/alexdeg92/homebrew-tap), and as `ghcr.io/alexdeg92/agent-office-oss:1.1.0`. See the [release](https://github.com/alexdeg92/agent-office-oss/releases/tag/v1.0.0).

| | npm | Homebrew | Docker |
| --- | --- | --- | --- |
| Install | `npm install -g @alexdeg92/agent-office` | `brew install alexdeg92/tap/agent-office` | `docker pull ghcr.io/alexdeg92/agent-office-oss:1.1.0` |
| One-shot | `npx @alexdeg92/agent-office` | — | — |
| Run | `agent-office start` (UI `/`, API `/backend`, port 18789) | `brew services start agent-office` | [Published image command below](#docker) (same one-port process) |
| Split | `start --api-only` and `web` | — | set `AO_API_ONLY=1` and run `web` behind a proxy |
| Needs | Node.js 24+ | Homebrew and Node (the formula depends on `node`) | Docker Engine; Compose v2 for the checkout examples |

For a first npm/npx install, run `agent-office setup` and follow the browser wizard, then `agent-office start`. For Homebrew, use the service's data directory during setup, as shown below. The published Docker command starts the wizard on first boot. Setup persists configuration and secrets locally.

For an environment-managed OpenClaw install, the required names are: `OC_GATEWAY_TOKEN`, `PORTAL_EMAIL`, `PORTAL_PASSWORD_HASH`, `PORTAL_SECRET`. Copy `.env.example` to a mode-`600` file and fill it in. Do not commit that file. npm and npx do not read that file on their own: pass `--env-file` (a variable already set in the environment wins; values are not printed). Homebrew's service script sources `~/.config/agent-office.env` or `AO_ENV_FILE`. Docker Compose uses `env_file`; an environment-managed `docker run` can use `--env-file`. A fresh wizard-based install does not require an env file.

## Try it without OpenClaw

`AO_RUNTIME=demo` selects the synthesised team ([adapters.md](adapters.md)). No gateway URL, no gateway token, and no runtime binary. You still choose a login. These values are for a local try; a kept install uses `PORTAL_PASSWORD_HASH` and an env file, not a password in the shell.

The Docker image sets `NODE_ENV=production`, so the session cookie is `Secure` unless `PORTAL_COOKIE_SECURE=0`. Set that for `http://127.0.0.1:18789/`. The interface is in French by default. Runtime writes stay off. The office, journal, and flows still move: the demo advances on its own every few seconds.

For a short local demo using the published image:

```sh
docker run --rm -p 127.0.0.1:18789:18789 -e AO_RUNTIME=demo -e PORTAL_COOKIE_SECURE=0 -e PORTAL_EMAIL=you@example.com -e PORTAL_PASSWORD=choose-a-password -e PORTAL_SECRET=choose-a-long-secret ghcr.io/alexdeg92/agent-office-oss:1.1.0
```

The same start with npx:

```sh
AO_RUNTIME=demo PORTAL_COOKIE_SECURE=0 PORTAL_EMAIL=you@example.com PORTAL_PASSWORD=choose-a-password PORTAL_SECRET=choose-a-long-secret npx @alexdeg92/agent-office start
```

From a built checkout, `node packaging/bin/agent-office.js start` with the same variables is the same process. Open `http://127.0.0.1:18789/`. The API is `http://127.0.0.1:18789/backend/api/v3/meta` (`runtime.id` is `demo`).

`agent-office hash-password` prints the scrypt line for `PORTAL_PASSWORD_HASH`. On a terminal it asks twice and does not echo; otherwise it reads stdin. It does not take the password as an argument or from the environment, and it prints only the hash.

`AO_PUBLIC_URL` is the origin people type in the browser, `scheme://host[:port]` with no path. Set it when people browse anything other than loopback. A one-port install bound to loopback, with no `AO_PUBLIC_URL`, allows cookie writes whose Origin is the loopback Host the browser used (`localhost`, `127.0.0.1`, or `::1` on the listen port). The internal proxy records each client's socket address in `X-Forwarded-For`, and the API trusts only that loopback hop.

Once it is running, how to use the app is [Using Agent Office](user-guide.en.md) and [Utiliser Agent Office](user-guide.fr.md). Replacing a running install is [upgrading.md](upgrading.md). A gateway that never connects, a 429 on login, a data directory that refuses to start, or a 403 on a write is [troubleshooting.md](troubleshooting.md).

## npm

For a fresh install:

```sh
npm install -g @alexdeg92/agent-office
agent-office setup
agent-office start
```

For an environment-managed install:

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
agent-office setup --data "$(brew --prefix)/var/lib/agent-office"
brew services start agent-office
brew services stop agent-office
```

`brew services` runs `agent-office-service`, which execs `agent-office start` on `127.0.0.1:18789` (UI at `/`, API at `/backend`). The data directory is Homebrew's `var/lib/agent-office` unless `AO_DATA_DIR` is set. If `~/.config/agent-office.env` (or `AO_ENV_FILE`) exists, the service script sources it and does not print it.

## Docker

For the published image:

```sh
docker pull ghcr.io/alexdeg92/agent-office-oss:1.1.0
docker run --rm -it --name agent-office \
  -p 127.0.0.1:18789:18789 \
  -v agent-office-data:/data -v agent-office-config:/config \
  -e PORTAL_COOKIE_SECURE=0 \
  ghcr.io/alexdeg92/agent-office-oss:1.1.0
```

Open the setup URL printed in the terminal and enter its one-time code. The two named volumes retain the local data and configuration across container restarts. `PORTAL_COOKIE_SECURE=0` is for local HTTP; use secure cookies and `AO_PUBLIC_URL` behind an HTTPS reverse proxy.

To build a local image from a checkout instead:

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


## First-run onboarding

If port 18789 is already used by your gateway or another service, start with `agent-office setup --port 18790` (or change the Compose host port).

A fresh npm/npx, Homebrew service or Docker start prints a setup URL and a one-time `AO-…` code. Open that URL, create the owner account (confirmed password, at least 12 characters), and enter the code. The owner is stored as a scrypt hash in the SQLite data volume. The browser then detects runtimes before asking for a connection, lets you edit each agent name and choose a character from the Store catalog, reviews per-agent skill file plans, and offers optional network/DNS guidance. Existing configured installs remain locked and retain their env/file login.

Detection reads the server process's home and configured state paths. The real detector supports OpenClaw; Hermes, opencode, Claude Code, Codex and Cursor CLI currently report presence and pending support. You can connect manually or use Demo when nothing is detected. A bureau still uses one active runtime adapter, even when several runtimes are detected.

The Docker Compose `.env` file is optional for a fresh onboarding install. Keep both `ao-data` and `ao-config`: the owner hash lives in `/data/agent-office.sqlite`, while the session signing key and runtime token live in `/config/secrets.json`. Back up the DB and instance configuration together; use `agent-office backup … --include-secrets` when preparing a complete private restore.

Docker can detect only mounted runtime data. Add mounts such as these to your own Compose override (replace the example paths):

```yaml
services:
  office:
    environment:
      OPENCLAW_STATE_DIR: /runtime/state
      # Use a reachable gateway URL from inside the container:
      OC_GATEWAY_URL: ws://host.docker.internal:18793
    volumes:
      - /path/to/runtime-state:/runtime/state:ro
      # Match workspace paths in the runtime config. Read-only permits detection;
      # change to read-write only when you intend to confirm skill installation.
      - /path/to/agent-workspaces:/path/to/agent-workspaces:ro
      # Presence-only examples; optional:
      - /path/to/claude-state:/home/ao/.claude:ro
      - /path/to/codex-state:/home/ao/.codex:ro
```

Agent workspace paths in the runtime configuration must be meaningful inside the container, including `IDENTITY.md`. A readonly workspace supports detection and preview; installation requires a writable workspace. The gateway must accept the container's connection; a loopback-only host gateway is not reachable through `host.docker.internal` without a suitable host-side route/proxy. On Linux, the supplied Compose host-gateway alias resolves the host but does not change gateway binding or authentication. The runtime token is read locally when available and is never sent back to the browser.

The network guide writes only Agent Office configuration. Restart Agent Office to apply saved host/port/public-origin/cookie settings. Compose's explicit `HOST=0.0.0.0` and `PORT=18789` retain precedence inside the container; the default published port remains host-loopback only. LAN/public access requires your own port mapping or proxy. The guide generates Caddy, Traefik, nginx, Tailscale and Cloudflare examples, checks DNS and `/build.json`, and never runs these commands or edits system files. Public IP detection is an optional external request. A DNS match or server-side access check does not establish inbound Internet reachability through NAT/firewalls.

Setup codes expire after 30 minutes. If one expires, restart Agent Office locally and use the fresh code from its log. A saved owner remains in the DB; the welcome screen asks for that code before revealing the saved account or resuming. Configured instances stay locked.
