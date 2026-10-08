# Changelog

All notable changes to Agent Office are documented in this file. The format is based on Keep a Changelog, and versions follow Semver. `packaging/release.sh` copies the matching section into `dist/RELEASE_NOTES.md`.

## 1.0.0 - 2026-10-06

Agent Office is a dashboard for a self-hosted AI agent. You watch the office, the conversations, the scheduled flows, the skills, the logs, and the health of the machine. The interface is in French by default, and you can switch it to English. OpenClaw is the runtime that feeds a real agent. The program does not name that agent for you: it follows whoever the instance is configured to follow.

This is the first packaged release of the new design. npm, the Homebrew tap, and the container registry are not published yet. Installing means a checkout, a local image, or a tarball you pack yourself.

### The new design

The old single page is replaced by the illustrated office. Sign-in is its own scene. After you sign in, the office is the home view: people move, tokens tick, and the journal and the flows update while you watch. Runtime writes (flows, skills, chat, and a gateway restart) can be turned off; the office still moves.

A default start is one process. The interface is at `/` and the API is at `/backend`, on port 18789. A reverse proxy can still split them: the web process serves `/`, and the API process (`AO_API_ONLY=1`) sits behind `/backend` with that prefix stripped.

### Setup

Secrets stay in the environment, not in the package or the image. An OpenClaw install needs `OC_GATEWAY_TOKEN`, `PORTAL_EMAIL`, `PORTAL_PASSWORD_HASH`, and `PORTAL_SECRET`. `agent-office hash-password` asks for the login password (twice, without echoing) and prints only the scrypt line. `agent-office check-config` prints `ok` or `missing` for each name and never prints a value.

A plaintext `PORTAL_PASSWORD` still starts this release, with a warning. Replace it with the hash and remove the plaintext.

### Try it without a runtime

`AO_RUNTIME=demo` starts a small synthesised team. It needs no gateway, no token, and no runtime binary. You still choose a login. The steps, including the Docker one-liner and `npx`, are in [Install](docs/guide/install.md). On a local `http://` address, set `PORTAL_COOKIE_SECURE=0` or the browser will not keep the session cookie. Demo does not accept runtime writes.

### Install

Three methods, none of them published yet:

- npm: `npm i -g agent-office`, then `agent-office start` (or `npx agent-office start`)
- Homebrew: `brew install alexdeg92/tap/agent-office`, then `brew services start agent-office`
- Docker: build `packaging/docker/Dockerfile` and run the image, or `docker compose -f packaging/docker/compose.yml up --build`

Node.js 24 or newer. The commands `start`, `web`, `check-config`, `hash-password`, and `version` are the CLI.

### API

`/api/v2` serves contract 2.5. `/api/v3` serves contract 3.0: the same routes, with open names for channels, session kinds, and the rest of the vocabulary that 2.5 still spells the old way. Both stay up. A client uses one of them for everything, including the live stream. Sign-in is still `POST /api/login`, `POST /api/logout`, and `GET /api/me`.

A process that still serves its own UI keeps the previous `/api/…` routes. The packaged one-port start, and an API-only process, do not mount them unless `AO_LEGACY_V1=1`. Moving an existing install is [Upgrade from v1](docs/guide/upgrade-from-v1.md).
