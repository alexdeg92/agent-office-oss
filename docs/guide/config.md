# Configuration

Two layers, and they do not overlap:

- **Wizard-managed installs:** `agent-office setup` opens the browser wizard. It writes the non-secret instance configuration to `$AO_CONFIG`, otherwise `$XDG_CONFIG_HOME/agent-office/config.json` (default `~/.config/agent-office/config.json`), and writes `secrets.json` beside it. Files are mode 0600 in a mode 0700 directory. Docker uses `/config/config.json` and `/config/secrets.json`.
- **Environment-managed installs:** `OC_GATEWAY_TOKEN`, `PORTAL_EMAIL`, `PORTAL_PASSWORD_HASH` and `PORTAL_SECRET` configure the runtime and owner login. Generate a password hash with `agent-office hash-password`. Supplying login environment variables locks the setup wizard. Keep values in a private env file and pass `--env-file`.
- **Precedence:** environment, then instance configuration and secrets files, then portable built-in defaults.

`check-config` (`agent-office check-config`) prints `ok` or `missing` for each key. It does not print values or paths. `--config` and `--data` are included in that check. `PORTAL_PASSWORD_HASH` alone is enough (`PORTAL_PASSWORD_HASH: ok`). This release still accepts `PORTAL_PASSWORD` without a hash (`PORTAL_PASSWORD_HASH: missing` and `PORTAL_PASSWORD: ok`). Either one passes the check. Both missing fails it.

## Environment

Names and meanings match `.env.example`. Set only what this instance needs.

| Variable | Required for env-managed login | Role |
| --- | --- | --- |
| `OC_GATEWAY_TOKEN` | yes | Runtime gateway token |
| `PORTAL_EMAIL` | yes | Login email |
| `PORTAL_PASSWORD_HASH` | yes | scrypt hash of the login password, from `agent-office hash-password` |
| `PORTAL_SECRET` | yes | Session cookie signing key |
| `PORT` | no | API port, default `18789` (the UI's own default is `8080`) |
| `HOST` | no | Bind address, default `127.0.0.1`. Use `0.0.0.0` in a container |
| `NODE_ENV` | no | `production` in the image |
| `AO_ENV` | no | `production`, `staging`, `dev`, or `test`. A data directory belongs to one instance |
| `AO_DATA_DIR` | no | Store directory. In the image, `/data` |
| `AO_CONFIG` | no | Instance config path. In the image, `/config/config.json` |
| `AO_API_ONLY` | no | `1`: the API serves no UI. Set on the API service |
| `AO_PUBLIC_URL` | no | Origin users type in the browser, `scheme://host[:port]` with no path. Required for cookie writes when that origin is not loopback (a name, a LAN address, or HTTPS). A loopback one-port install uses the browser's Host and does not need this |
| `AO_PUBLIC_API_BASE` | no | Prefix the browser uses. Default `/backend` when API-only |
| `AO_API_BASE` | no | Same prefix, read by the static server. Default `/backend` |
| `AO_BASE_PATH` | no | UI mount point. Default `/` |
| `PORTAL_DISPLAY_NAME` | no | Owner display name. Default: the email's local part |
| `PORTAL_COOKIE_SECURE` | no | `1` or `0`. Default on when `AO_ENV=production` |
| `PORTAL_READONLY` | no | `1` refuses runtime and OpenClaw writes (flows, skills, gateway restart, chat). Staging, and it cannot be `AO_ENV=production`. Store writes stay allowed |
| `PORTAL_READONLY_STORE` | no | `1` refuses store writes (projects, layout, preferences, mute). Set this and `PORTAL_READONLY` to block every application write |
| `OC_GATEWAY_URL` | no | Gateway WebSocket URL. Default `ws://127.0.0.1:18793` |
| `OC_HOME` | no | Runtime home. Every runtime path derives from it |
| `AO_PROJECTS_OWNERS` | no | Code-host owners. Discovery stays off until this or a workspace root is set |
| `AO_PROJECTS_ROOT` | no | Workspace root for discovery. No default path |

## Instance files

The wizard saves instance name, locale, time zone, owner display name and email, runtime adapter and gateway URL, primary agent, character choices and integration preference in `config.json`. The sibling `secrets.json` holds the runtime token, password hash and session signing secret. Keep both files private and back them up together. Reuse the same `--config` and `--data` paths after setup.

Use `agent-office integrations status` to review the project skill and AGENTS.md integration, and `agent-office integrations install` to install it for the primary agent (`--all` selects every agent; `--dry-run` previews).
