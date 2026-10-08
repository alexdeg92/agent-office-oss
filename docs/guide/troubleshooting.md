# Troubleshooting

These are the failures that show up on a new install. How to use the pages, once the app is running, is [Using Agent Office](user-guide.en.md) and [Utiliser Agent Office](user-guide.fr.md). Configuration names are in [config.md](config.md).

## Start with `agent-office doctor`

`agent-office doctor` checks an install and prints what it finds. It is read-only: it creates, fixes and migrates nothing, and it never prints a value (secrets, tokens, the password hash, the session secret). It names variables and shows paths, versions, modes and counts.

```sh
agent-office doctor                                   # this machine's install
agent-office doctor --url https://agent.example.org   # also the public address and the proxy
agent-office doctor --json --lang en                  # for scripts; --lang fr is the default
```

Use the same environment as the server, for example `--env-file ~/.config/agent-office.env`. `--config` and `--data` work as they do for `start`.

| Group | What it checks |
| --- | --- |
| Environment | The owner login is complete (`PORTAL_EMAIL`, `PORTAL_SECRET`, a password hash), and whether each piece comes from the environment or the configuration file. Every variable the server would refuse at start (`AO_ENV`, `AO_RUNTIME`, `AO_ENRICHERS`, retention, `AO_TIME_ZONE`, `PORTAL_PASSWORD_HASH`) is reported by name. Also the runtime token, and the deprecated plaintext `PORTAL_PASSWORD` |
| Configuration files | `config.json` is valid; an interrupted setup left `secrets.json` alone; files are `0600` and directories `0700`. The server tightens permissions on files you own and refuses files someone else owns. The doctor only reports it, with the `chmod` to run |
| Data directory | It exists or can be created, it is writable, and the store belongs to this instance (`AO_ENV`). It also says whether a server is using it now |
| Store | `PRAGMA integrity_check`, and the schema version against this build: current, upgraded at the next start, or too new |
| Runtime (OpenClaw) | The device identity, then one read-only gateway connection: whether it is reachable, the protocol (v4), the OpenClaw version against the tested ones, the `operator.read` scope (one agent listing), the methods it needs, and the clock skew. Then the `openclaw` CLI: present, its version against the gateway's, and `skills list --agent <primary>` (without `--agent` the Skills page is empty). The demo adapter has nothing to check |
| Public URL (with `--url`) | The address answers; HTTPS and HSTS; where the API is (`--api-base`, `AO_PUBLIC_API_BASE`, then `/backend` and `/`); how the server saw the request through the proxy (`/healthz/proxy`); `AO_PUBLIC_URL` matches; the clock against the server's `Date` |
| Host | Free disk space on the data volume, and the Node version (24 or later) |

Each line is ✓ ok, `i` info, `!` warning, ✗ failure, or `-` skipped. **Exit codes:** `0` means everything is ok or informational, `1` at least one warning, `2` at least one failure, `64` a usage error.

What the common findings mean:
- **The clock is off the gateway's.** The gateway refuses a device signature more than 120 s off, so the dashboard can't connect. Above 30 s is a warning. Synchronise the clock (NTP) on both machines.
- **"The server sees plain HTTP behind HTTPS".** The proxy doesn't forward `X-Forwarded-Proto`, or Agent Office doesn't trust the proxy. Set `AO_TRUST_PROXY` to the proxy's address or network (for example `loopback,172.30.0.0/16`).
- **"Forwarded headers are ignored".** The same fix. Until then, login throttling counts every user as the proxy's address.
- **`AO_PUBLIC_URL` is not set, or doesn't match.** Writes from that address are refused with 403 csrf (see below).
- **"Untested version".** Agent Office runs, but it has not been tested with this OpenClaw release. Check the data-quality panel after upgrading.

## The gateway is not configured

The process still starts. The gateway client does not open a connection when it has nothing safe to connect with. The log line is `not configured (<reason>): not connecting`.

| Reason | What is missing |
| --- | --- |
| `no-token` | `OC_GATEWAY_TOKEN` |
| `no-identity` | A device identity under the runtime home (`OC_HOME`, default `~/.openclaw`) |
| `identity-invalid` | An identity file or database row that is present but not usable |

Set the token, and point `OC_HOME` at the runtime home that holds the identity. The gateway URL defaults to `ws://127.0.0.1:18793` (`OC_GATEWAY_URL`). From Docker on the same host, that is `ws://host.docker.internal:18793`. See [adapters.md](adapters.md).

The dashboard then has no live runtime data. Fix the configuration and start Agent Office again. Do not restart the runtime gateway as a substitute for a missing token or identity.

## Login returns 429

A run of failed logins makes the next attempt wait. The response is HTTP 429 and includes `Retry-After` (seconds). A correct password during that wait is still refused.

- One address gets 5 failures inside 15 minutes before the wait starts. Each further failure doubles the wait, up to 15 minutes. A successful login clears that address.
- More than 20 failures in one minute, from any addresses, slows every login.
- Only two password checks run at once for one address (16 for the whole process). The rest wait 1 second.

Wait out `Retry-After`. The counters live in the Agent Office process. The client address is the socket address, or `X-Forwarded-For` when the proxy is one `AO_TRUST_PROXY` trusts (default: loopback only). On a one-port install the proxy records each socket itself, so two browsers are two addresses.

## The data directory belongs to another instance

`AO_ENV` is `production`, `staging`, `dev`, or `test`. The first start writes that name into the store. A later start with a different `AO_ENV` on the same directory stops before it changes anything. The error says the data dir belongs to the recorded instance, not the one that is starting.

A staging, dev, or test process also refuses the production default directory, including when the path is a symlink to it. The message is `Refusing to start: the <instance> instance would use production's data dir`. Set `AO_DATA_DIR` to a directory that belongs to that instance.

`PORTAL_READONLY=1` is staging. It cannot be combined with `AO_ENV=production`.

Give each instance its own directory. Upgrades keep the existing directory and the existing `AO_ENV`. See [upgrading.md](upgrading.md).

## A write returns 403 csrf

Cookie writes on a one-port install must come from the origin the browser used.

- Set `AO_PUBLIC_URL` to that origin when it is not loopback: a hostname, a LAN address, or HTTPS. The form is `scheme://host[:port]` with no path.
- With no `AO_PUBLIC_URL`, open the app as `http://127.0.0.1:<port>/`, `http://localhost:<port>/`, or `http://[::1]:<port>/`, where `<port>` is the port Agent Office listens on (18789 unless `PORT` is set).

A foreign `Origin` stays 403, including when the request also sends `X-AO-Request: 1`. Login can succeed and later writes can still fail for this reason. The check is in [install.md](install.md) and [config.md](config.md).
