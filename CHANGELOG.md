# Changelog

All notable changes to Agent Office are documented in this file. The format is based on Keep a Changelog, and versions follow Semver. `packaging/release.sh` copies the matching section into `dist/RELEASE_NOTES.md`.

## 1.3.0 - 2026-10-20

This release lets you talk to every agent from Discuter, shows headless agent swarms by name in the office, and moves the owner account into the database so it can be edited from Settings.

### Upgrade note

- On first start, the owner account defined by `PORTAL_EMAIL` / `PORTAL_PASSWORD_HASH` is migrated into the database (migration 036, after an automatic pre-migration backup). Your email and password stay the same; you can then change your name, email and password in Settings › Account. The environment credentials remain as an emergency recovery login, limited to repairing the owner account for 10 minutes and recorded in the audit log.

### Chat

- **Every agent:** Discuter lists all your agents (OpenClaw, Claude Code, Codex, team members) by name, and shows only the conversations you started there; runtime sessions stay in Logs.
- **Busy agents:** a message to an agent that is working waits (« En attente ») and is delivered as soon as it is free; « Envoyer maintenant » sends it right away after a warning. Queued messages can be cancelled and survive restarts.
- **Conversations:** rename inline, delete with confirmation, swipe left/right on phones, a ⋯ menu on desktop.
- **Attachments:** images and documents with previews; the text stays in its bubble and images line up beneath it, on the sender's side.
- **Bubbles** size to their text up to 85 % of the width on phones and 70 % on desktop.
- Long agent turns no longer time out, and replies from delegated runs are picked up when they finish.

### Office

- **Headless swarms:** agents launched without terminal panes (ACP, native sub-tasks) appear with their registered name, role, runtime and status; private session titles and summaries are never used as names.
- **Team portraits:** each member keeps their own stable character, distinct within the team and never the main agent's; the role line no longer repeats the name.
- **People involved** shows one compact line per member.
- Visiting human contacts appear as visitors; conversations and channels keep their own role.
- A temporarily absent teammate keeps their desk.

### Fixes

- Readers without session access can open the office again.
- Session views no longer fail when a participant has two identities.
- Older Claude Code history keeps loading after the first window and after new messages.
- Generic sub-agents show a translated « Sous-agent » / « Sub-agent » label.
- Missing French and English labels for visitors, « visiting with » and team groups were added.
- Logging out always ends an account-recovery session.

## 1.2.3 - 2026-10-14

This release makes customizing the office comfortable on a phone, shows sub-agent results properly in the chat, and fixes session history for Claude Code and Codex.

### Customize

- **Live character preview:** while you customize an agent, a large preview replaces the office map and updates as you pick the character, colour, accessories or pose. Accessories are shown as pictures.
- **Phone layout:** Disposition and Thème open on a full-screen catalogue with search and a category menu; the map appears only to place an item or preview the theme. The toolbar fits on one line and « Plus d'actions » lets you switch floors.
- **Store:** Floor, Section and Category are dropdowns (one row on desktop) instead of a scrolling tab strip.
- **Characters:** the roster lists the agents present in the office, grouped under their lead, with search; lists scroll inside their frame.
- **Presence timings** (finished sessions, agent presence, idle relocation) are editable in Settings.

### Chat

- **Sub-agent results** appear as collapsible cards on the agent's side, with the sub-agent's portrait, task title and state, instead of looking like your own messages.
- **Agent portraits** from the office are used as chat avatars.
- **Tables and bold text** render inside messages; wide tables scroll sideways and no longer trap vertical touch scrolling.

### Office

- Idle agents keep their own desk unless the floor is full; borrowed desks return to their owner and agents no longer overlap.
- Thinking agents at their desk show it on their monitor; the « ? » glyph is gone.
- Desk monitors raise a visible alarm when an agent is blocked.
- Live updates carry exactly the same office state as a page load.

### Projects (API)

- API v3 exposes read-only Claude Code and Codex workspace projects and team sources, gated by read permissions with opaque identifiers. The v2 board is unchanged; the new Projects page will use v3.

### Fixes

- Claude Code and Codex session logs show the whole conversation instead of only the last exchange, with bounded, fair incremental reads of large transcripts.
- Sessions and comments no longer fail on duplicated event identifiers, and summary requests no longer stay pending.
- Choosing a connector in Settings is no longer reset to « all ».
- Hidden and missing projects return identical not-found responses.
- The public export rebuild includes the desk monitor manifest.

## 1.2.2 - 2026-10-13

This release makes the office read like a real workplace: every agent has its own desk, you can see what each one is doing, and idle agents doze or take breaks.

### Office life

- **Rich states:** working, thinking, executing, blocked and « En attente » (waiting for a reply or for background work) are shown on the character and in the roster.
- **Desk monitors** show the agent's current action (writing code, running a command, searching, reading, blocked…).
- **Dozing at the desk:** an idle agent rests its head on the desk, its monitor turns off and cartoon « z Z z » letters float up from its head.
- **Desk pressure:** working agents always get a desk; when a floor is full, the longest-idle agents give up their desk and go to the lobby or the gym. An agent that starts working again returns to its own floor and desk.
- **Elevator travel:** agents take the elevator between floors for breaks (lobby armchairs, terrace bench, coffee, smoking, gym), several at a time.
- **Conversations happen from each agent's own desk** instead of everyone crowding one desk or the meeting table.
- **Stable team floors:** a team's home floor and desks persist across refreshes, restarts and viewers.

### Fixes

- Fixed team agents gathering at the entrance with free desks after an identity merge; limited (no session access) viewers get the same seats without any private data.
- Fixed the interface freezing until reload (chunk-load recovery, safe prefetch, per-page error boundaries).
- Office projection is bounded for large session histories.
- Codex and Claude Code waiting/working detection is safe on very large transcripts.

## 1.1.0 - 2026-10-09

This release adds a guided first run, a cast of eleven characters, and an office that lives on its own. Existing installs upgrade in place: the store migrates forward, with a backup taken first, and a configured instance keeps its login.

### First-run onboarding

A fresh install now starts with a setup wizard instead of an env file. The server prints a setup URL and a one-time `AO-…` code (valid for 30 minutes).

1. You create the owner account. The password is stored as a scrypt hash in the local SQLite store.
2. Agent Office detects the agent runtimes on the machine and the agents they declare, with their names. When it finds no name, it asks you for one.
3. You choose a character for each agent.
4. It shows the skill files it plans to install for each agent, then installs them.
5. Optional network and DNS guidance covers local only, LAN, Tailscale, Caddy, Traefik, nginx and Cloudflare, with DNS and `/build.json` checks. The guide never edits system files.

OpenClaw is detected fully. Hermes, opencode, Claude Code, Codex and Cursor CLI are reported as present, with full support pending. A configured instance stays locked and is never reopened by the wizard. The steps, including Docker mounts for detection, are in [Install](docs/guide/install.md#first-run-onboarding).

### Characters

The Store now ships eleven character packs:
- Rivet rétro, Orbite, Bastion, Fil androïde, Chenille, Minou-bot
- Renard, Hibou, Manchot, Bulle, Cosmonaute

Each pack is a full sprite set with every pose and facing the office uses, and you can assign it to any agent. Packs are validated against a shared contract, and their size is capped as they download, before they are parsed.

### Office life

- Agents sit properly in their chairs and hold props in hand, with gear registered per facing.
- Idle agents go for walks:
  - ten landmark interactions, such as the plant, the gym and a smoke break
  - reactions in glyph bubbles
  - high-fives and chats with each other
- The outdoor scene follows day and night, and sometimes rain.
- `/bureau/test-animations` is a sandbox page that plays every animation for every character on demand. It is useful when you make a pack.

### Conversations

- In a group chat, each message keeps its own sender identity, for humans and agents alike. The model is runtime-agnostic, and group membership comes from the runtime's own metadata.
- The participants summary lists humans and primary agents, and folds delegates into "+ N sous-agents".

### Reliability and security

- Backups and restores go through a safe file layer. It checks each path's identity before trusting it, refuses directories that other users can write to, never takes a backup inside an open transaction, and keeps the previous backup when the copy fails.
- Skill homepage links accept bounded `http(s)` URLs only, in both the server and the interface.
- Setup codes expire and are checked locally.
- Partial migrations keep a valid owner lookup.

### API

`/api/v2` now serves contract 2.7 and `/api/v3` serves contract 3.2. Both add owner onboarding and peer identity.

### Package

The npm package is larger because of the character art: up to 55 MiB, up from the previous budget. Node.js 24 or newer is still required.

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
