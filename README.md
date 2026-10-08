# Agent Office

Agent Office is a self-hosted dashboard for **OpenClaw agents**. An animated office shows your team at work; chat, workflows, projects, logs, skills and health views help you follow what they are doing. The interface supports English and French. Runtime adapters keep the dashboard independent of a particular installation.

Requires Node.js **24 or newer**, or Docker. OpenClaw is the first supported runtime; a synthetic demo adapter is included.

## Install

```sh
npm install -g @alexdeg92/agent-office
agent-office --version
```

```sh
brew install alexdeg92/tap/agent-office
```

```sh
docker pull ghcr.io/alexdeg92/agent-office-oss:1.0.0
docker run --rm -it --name agent-office \
  -p 127.0.0.1:18789:18789 \
  -v agent-office-data:/data -v agent-office-config:/config \
  -e PORTAL_COOKIE_SECURE=0 \
  ghcr.io/alexdeg92/agent-office-oss:1.0.0
```

The Docker command uses HTTP on your local machine. Set `AO_PUBLIC_URL` to your HTTPS origin and use secure cookies when serving through a reverse proxy. Mount the required OpenClaw identity/config files read-only and set `OC_BIN` if your container provides the OpenClaw CLI; the dashboard image does not bundle OpenClaw. See [installation](docs/guide/install.md) for gateway configuration and split UI/API deployments.

## First run

```sh
agent-office setup
```

Open the printed URL (normally `http://127.0.0.1:18789/`) and enter the one-time setup code from the terminal. The browser wizard connects to your OpenClaw gateway, discovers agents, chooses the primary agent and creates your owner login. Configuration persists across restarts. An existing configuration or login environment variables keep setup locked.

After setup, start the dashboard with `agent-office start`. The UI is at `/` and the API at `/backend` on the same port. Use the same `--config` and `--data` paths on subsequent runs if you supplied them during setup.

The wizard can install the project-tag integration. You can also review and install it explicitly:

```sh
agent-office integrations status
agent-office integrations install
```

The integration adds a project skill and an AGENTS.md block to the selected agent workspace, with a backup before changes. Use `--all` for every agent or `--dry-run` to preview. See [project integration](docs/guide/project-tag.md).

For Homebrew, complete setup before `brew services start agent-office`. The service uses Homebrew's `var/lib/agent-office` data directory; pass that directory with `--data` during setup. Docker opens the same wizard on first boot and stores its configuration in the named volumes.

## Configuration

The wizard writes instance configuration and a separate secrets file with restricted permissions. Environment variables override file configuration. For environment-managed installs, copy [.env.example](.env.example) to a private file and use `agent-office start --env-file /path/to/agent-office.env`.

| Variable | Purpose |
| --- | --- |
| `AO_CONFIG`, `AO_DATA_DIR` | Instance configuration and persistent data paths |
| `OC_GATEWAY_URL`, `OC_GATEWAY_TOKEN` | OpenClaw gateway connection |
| `OC_HOME`, `OC_IDENTITY`, `OC_BIN` | Runtime home, device identity and CLI overrides |
| `PORTAL_EMAIL`, `PORTAL_PASSWORD_HASH`, `PORTAL_SECRET` | Owner login and session signing for environment-managed installs |
| `HOST`, `PORT` | Listen address and port (default port 18789) |
| `AO_PUBLIC_URL` | Browser-facing origin for a reverse proxy |
| `AO_RUNTIME=demo` | Synthetic team without an OpenClaw connection |

Generate a password hash with `agent-office hash-password`. `agent-office check-config` reports presence without printing values; `agent-office doctor` diagnoses an installation. The complete reference is [configuration](docs/guide/config.md).

## Develop

```sh
npm ci
node scripts/build-frontend.js
npm run test:release
node packaging/bin/agent-office.js setup
```

Build before testing or packing. `packaging/export-public.sh <outdir>` creates a tree without Git history or local captures and runs a privacy gate over every exported file. Set `PORTAL_EMAIL` to the private address to check it without writing the value into the repository. Release preparation is described in [packaging](packaging/homebrew/README.md).

[User guide](docs/guide/user-guide.en.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

## En français

Agent Office est un tableau de bord auto-hébergé pour vos agents OpenClaw : bureau animé, conversations, projets, automatisations et santé du système. Installez-le avec `npm install -g @alexdeg92/agent-office`, puis lancez `agent-office setup` et suivez l’assistant dans le navigateur. L’interface est disponible en français et en anglais. Consultez le [guide français](docs/guide/user-guide.fr.md).

## Licence

[MIT](LICENSE). Bundled fonts retain their accompanying Open Font License notices.
