# Configuration

Two ways to configure an install, with the same precedence:

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

The wizard saves instance name, locale, time zone, owner display name and email, runtime adapter and gateway URL, primary agent, character choices and integration preference in `config.json`. For legacy config v1, sibling secrets.json holds the runtime token, password hash and signing secret. Modern config v2 keeps the owner hash only in SQLite and the runtime token/signing secret in secrets.json. Keep both files private and back them up together. Reuse the same `--config` and `--data` paths after setup.

Use `agent-office integrations status` to review the project skill and AGENTS.md integration, and `agent-office integrations install` to install it for the primary agent (`--all` selects every agent; `--dry-run` previews).

## Wizard owner, agents and network

New onboarding accounts use the migration-014/015 `users` table in the SQLite store, linked to the owner Person. Passwords use the existing scrypt password module; they are absent from `secrets.json` for these accounts. `config.owner.authSource = "database"` selects this login mode. Existing files with `passwordHash`, or a complete explicit environment login, keep legacy login behavior. Only a complete email/secret/password-or-hash environment login replaces file auth; every incomplete login override is a named boot error and leaves stored database authentication intact. DB session cookies identify the stable users.id. The sole supported role is owner.

`config.agents.names[adapterId]` contains local display-name overrides keyed by stable runtime agent id; it does not rename the agent in the runtime. `agents.looks` seeds the initial Bureau layout from the shared catalog and enabled packs. The named agents remain visible while idle; peers use agent:<id>, while delegated sessions retain subagent:<subject> and alone count toward the subagent KPI. The active runtime/primary-agent resolver remains one per instance.

`config.network` holds the chosen access mode, bind host/port, public origin and secure-cookie preference. Onboarding accepts `local`, `lan`, `tailnet`, `public` and `tunnel`. Public/tunnel/tailnet origins require HTTPS. Host/port and origin changes take effect after restart; explicit `HOST`, `PORT`, `AO_PUBLIC_URL` and `PORTAL_COOKIE_SECURE` still win. The combined CLI applies stored settings to its public UI listener and keeps the child API on a separate loopback port. `OPENCLAW_STATE_DIR` overrides the runtime state directory for discovery and connection identity paths.

The detector registry is `src/adapters/detectors/`: a new detector file adds a discovery entry. Implemented adapters expose their setup fields, probe, configuration and integration discovery hooks. Presence-only detectors do not install skills. The wizard shows exact file plans and requires a confirmation before invoking the existing adapter installer; uninstall is available in the same step or afterwards with `agent-office integrations uninstall`. It backs up modified `AGENTS.md` files inside the Agent Office data directory and never edits runtime config, system DNS or proxy files.

Proxy/tunnel syntax follows the official [Caddy reverse-proxy guide](https://caddyserver.com/docs/quick-starts/reverse-proxy), [Traefik HTTP router reference](https://doc.traefik.io/traefik/reference/routing-configuration/http/routing/router/), [nginx proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html), [Tailscale Serve documentation](https://tailscale.com/docs/features/tailscale-serve) and [Cloudflare named-tunnel guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/). The snippets require your domain, certificates/resolver and tunnel credentials as applicable.


While setup remains open, verify the fresh local setup code, then use **Modifier le compte / Edit account** to correct name/email or replace the password. Omitting a replacement password preserves the current hash. A valid DB-auth config with a missing owner row reopens this code-protected recovery; a configured owner is locked, and a missing private secrets file serves locked setup with a clear restore-and-restart message and no setup code or writes. Config v2 and schema 015 are forward migrations; rollback restores a private pre-upgrade DB/config/secrets backup (operations.md). All default backups containing owner hashes are sensitive.

A gateway URL override does not borrow the private file's token for a different destination. Supply the URL and token together for a new gateway. Runtime detection follows the same rule for local and remote credentials.
