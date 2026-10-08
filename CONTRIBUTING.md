# Contributing

Agent Office is a Node.js 24 application. Dependencies are `express` and `ws`. Tests use the built-in `node:test` runner. Do not add a package for something the runtime already provides.

Docs are in English. User-facing interface text is in French. A new string belongs in both `src/i18n/fr.js` and `src/i18n/en.js`.

## Setup

Install Node.js 24, then `npm ci` in a checkout. `npm test` runs every `test/**/*.test.js`. The suite does not contact a live gateway, run a real runtime binary, or touch a real runtime home. Each store test uses its own temporary data directory.

Details of the harness, fixtures, and goldens are in [test/README.md](test/README.md). A golden diff is a bug or a deliberate change that the changelog names.

## Issues and pull requests

Use the templates in [.github/ISSUE_TEMPLATE](.github/ISSUE_TEMPLATE) and [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md). Describe the behaviour you saw and the adapter id (`openclaw` or `demo`). Do not paste tokens, passwords, session cookies, or a data directory.

## Contracts and examples

The wire contract for shared view models and commands is the JSON in [docs/architecture/examples](docs/architecture/examples). The [examples README](docs/architecture/examples/README.md) lists each file. Producers check their builders with `compareShape` / `compareExample` from `test/helpers/contract-shape.js`. Consumers build mocks from those files. A shape change starts with the example and the API notes, then the producers and the consumers.

Do not invent a field that the example and the API notes do not already have.

## Adapter rules

A runtime is an adapter. The rules are [ADR-001](docs/architecture/adr-001-runtime-adapters.md). How to add one is [docs/guide/adapters.md](docs/guide/adapters.md).

- Runtime-specific transport, raw schemas, and commands live in `src/adapters/<runtime>/`. OpenClaw is `src/adapters/openclaw/`. The synthesised team is `src/adapters/demo/`.
- Register the id in `src/adapters/index.js`. The core, the API, and the UI see canonical types and capability flags. They do not import adapter internals.
- Tokens and device keys stay inside the adapter. They do not appear on canonical types.
- One adapter per instance. A second runtime is a new adapter plus its fixtures, not a branch in the core.
- Commands exist only when the matching capability is true, and they return a command outcome rather than upstream text.

## What not to put in a change

Do not commit secrets, an environment file with values, a data directory, or a capture of a real instance. `.env.example` has names only. Do not commit a home-directory path, a tailnet address, or a production hostname.
