# Upgrading

An install that still runs the v1 single-page app is [upgrade-from-v1.md](upgrade-from-v1.md). Each later upgrade replaces the program and leaves the data directory in place. Secrets stay in the environment file. They are not copied into the package, the formula, or the image. A git checkout supervised by systemd is [deploy.md](deploy.md): a `current` symlink, then `scripts/golive-smoke.sh`.

After any upgrade, run `agent-office check-config` (or `docker run --rm IMAGE check-config` with the same environment). It reports `ok` or `missing` and does not print values.

The API applies numbered SQLite migrations when it opens the store (`src/store/db.js`). An existing database is backed up before a pending migration (`backups/agent-office-premigrate-v*.sqlite`). A program older than the store's schema refuses to start and leaves the file unchanged. Keep the data directory for one instance only, and keep the same `AO_ENV`. A directory that already belongs to another instance refuses to start. See [troubleshooting.md](troubleshooting.md).

How to use the app after it is up is [Using Agent Office](user-guide.en.md) and [Utiliser Agent Office](user-guide.fr.md).

## npm

```sh
npm i -g agent-office@X.Y.Z
agent-office check-config
```

Restart the API and the UI processes after the install. `--data` (or `AO_DATA_DIR`) must still point at the existing directory.

## Homebrew

```sh
brew update
brew upgrade alexdeg92/tap/agent-office
brew services restart agent-office
```

The service data directory stays `var/lib/agent-office` unless `AO_DATA_DIR` is set. The formula's `agent-office-service` still sources `AO_ENV_FILE` or `~/.config/agent-office.env` and does not print that file.

## Docker

Pull or rebuild the tag you intend to run (`agent-office:X.Y.Z`, or the local tag from `packaging/release.sh`). Recreate the containers and keep the `ao-data` and `ao-config` volumes:

```sh
docker compose -f packaging/docker/compose.yml up --build -d
```

Do not delete the data volume as part of an upgrade. The config volume is the instance file once G4 reads it; today the process still boots from the environment (see [config.md](config.md)).
