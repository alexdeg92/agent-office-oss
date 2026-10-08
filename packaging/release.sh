#!/bin/sh
# Prepare a release locally. Does not publish, push, or upload.
#   packaging/release.sh --version X.Y.Z
set -eu
cd "$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"

usage() {
  printf '%s\n' 'usage: packaging/release.sh --version X.Y.Z' >&2
}

version=''
if [ "${1:-}" = '--version' ] && [ -n "${2:-}" ] && [ -z "${3:-}" ]; then
  version=$2
else
  usage
  exit 2
fi

if ! node -e 'require("./packaging/release-tools").assertVersion(process.argv[1])' "$version"; then
  usage
  exit 2
fi

porcelain=$(git status --porcelain) || {
  printf '%s\n' 'release: git status failed' >&2
  exit 1
}
if [ -n "$porcelain" ]; then
  printf '%s\n' 'release: git tree is not clean' >&2
  exit 1
fi

node scripts/build-frontend.js
npm run test:release

npm version "$version" --no-git-tag-version --allow-same-version

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT INT TERM
node -e 'require("./packaging/release-tools").stagePackage(process.cwd(), process.argv[1])' "$stage"
mkdir -p dist
tarball="dist/alexdeg92-agent-office-${version}.tgz"
( cd "$stage" && npm pack --json --pack-destination "$OLDPWD/dist" ) > dist/pack.json
test -f "$tarball"
node packaging/check-pack.js dist/pack.json
sha=$(sha256sum "$tarball" | awk '{print $1}')
printf '%s  %s\n' "$sha" "alexdeg92-agent-office-${version}.tgz" > "dist/alexdeg92-agent-office-${version}.tgz.sha256"

node -e '
const fs = require("fs");
const { updateFormula } = require("./packaging/release-tools");
const file = "packaging/homebrew/agent-office.rb";
fs.writeFileSync(file, updateFormula(fs.readFileSync(file, "utf8"), process.argv[1], process.argv[2]));
' "$version" "$sha"

mkdir -p dist/homebrew-tap/Formula
cp packaging/homebrew/agent-office.rb dist/homebrew-tap/Formula/agent-office.rb
printf '%s\n' '# Agent Office Homebrew tap' '' 'Install: `brew install alexdeg92/tap/agent-office`' '' 'Dashboard for OpenClaw agents. MIT. https://github.com/alexdeg92/agent-office-oss' > dist/homebrew-tap/README.md

packaging/export-public.sh dist/public
docker build --provenance=false -f packaging/docker/Dockerfile -t "agent-office:${version}" .
IMAGE="agent-office:${version}" node --test packaging/first-run.test.js
IMAGE="agent-office:${version}" packaging/docker/smoke.sh

node -e '
const fs = require("fs");
const { releaseNotes } = require("./packaging/release-tools");
const notes = releaseNotes(fs.readFileSync("CHANGELOG.md", "utf8"), process.argv[1]);
fs.mkdirSync("dist", { recursive: true });
fs.writeFileSync("dist/RELEASE_NOTES.md", notes);
' "$version"

printf '%s\n' "release: prepared ${version}"
printf '%s\n' "tarball: ${tarball}"
printf '%s\n' "sha256:  ${sha}"
printf '%s\n' "image:   agent-office:${version}"
printf '%s\n' "notes:   dist/RELEASE_NOTES.md"
printf '\n'
node -e 'process.stdout.write(require("./packaging/release-tools").publishCommands(process.argv[1]))' "$version"
