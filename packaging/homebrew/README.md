# Homebrew tap

Install with `brew install alexdeg92/tap/agent-office`. The tap repository is `alexdeg92/homebrew-tap`; its formula belongs at `Formula/agent-office.rb`.

The MIT-licensed formula depends on `node` and installs the scoped npm tarball from `https://registry.npmjs.org/@alexdeg92/agent-office/-/agent-office-<version>.tgz`. `packaging/release.sh --version X.Y.Z` computes its SHA-256 from the actual packed tarball and prepares `dist/homebrew-tap/Formula/agent-office.rb` and a tap README. It publishes nothing.

Run `agent-office setup` before starting the service, using `--data "$(brew --prefix)/var/lib/agent-office"`. The service starts the UI at `/` and the API at `/backend`, bound to `127.0.0.1:18789`. It sources `AO_ENV_FILE` or `~/.config/agent-office.env` if present. Keep configuration files private. The service data directory is Homebrew's `var/lib/agent-office`.

To prepare a release: build with `node scripts/build-frontend.js`, run the targeted release tests, pack and verify the runtime files, then build and smoke-test Docker. The release script requires a clean Git tree. Public history must start from `packaging/export-public.sh` output, never a push of private history.

`ruby -c packaging/homebrew/agent-office.rb` checks syntax. `packaging/test-install.sh` tests a temporary npm installation, audits the formula if Homebrew is installed, then tests Docker. Publishing the prepared tree, npm tarball, container image and tap is a separate operator action.
