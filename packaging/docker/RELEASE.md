# Verified image releases

A `vX.Y.Z` tag in the public repository starts `.github/workflows/release.yml`.
The version must match `package.json`. Source/package verification runs first.
Each advertised platform (`linux/amd64`, `linux/arm64`) builds once, exports an
unnamed registry manifest by digest, and pulls that exact digest. Runtime file
presence, packaged first run (Docker and npm), API smoke and demo smoke must all
pass before its evidence artifact is written. The image's architecture and OCI
source revision are checked against the matrix and `GITHUB_SHA`.

`promote-images.js` refuses a missing/duplicate platform, failed/missing check,
wrong source/base or malformed digest before any promotion. It creates a
candidate index from those exact verified digests, reads the immutable index
back to check both platform descriptors, then copies that index digest to the
version and `latest` tags. It reads both release tags back. There is no build in
the promotion job. npm publication also waits for both image verification jobs.
The release evidence artifact records source commit, pinned base index,
per-platform manifests/checks and the published index digest.

Both Docker stages pin the same multi-platform Node 24 base index. Updating it
is a deliberate Dockerfile change: resolve the new official `node:24-slim`
index, check it includes both advertised platforms, update both `FROM` lines,
and run the image gates. A moving tag alone is never a build input.

For a local smoke test, omitting `IMAGE` builds the local image once. Supplying
`IMAGE` never rebuilds it; smoke resolves it to a local immutable image ID before
running commands. `demo-smoke.sh` does the same. `release.sh` captures the image
ID immediately after its one build and uses it for first-run/API/demo checks
and printed operator publication commands. A local release certifies only the
platform it built; multi-platform publication goes through the gated workflow.

Registry manifests uploaded during verification are not release tags. A failed
platform cannot produce evidence or promote release tags. Release tag creation
is a registry operation; the pipeline verifies the result, but does not promise
an atomic update of two tags against another authorized registry writer.
