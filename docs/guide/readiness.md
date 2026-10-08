# Open-source readiness

This is the checklist for a public release. It does not mark the items done. Licence text is not chosen here.

## Tree hygiene

- [ ] No `.env`, tokens, or private keys in git. `.env` and `.env.*` are ignored; `.env.example` has names only.
- [ ] `instance/` stays out of the repo (this server's deployment files).
- [ ] `test/fixtures/local/` and `test/golden/local/` stay out of the repo (captured real data).
- [ ] `CLAUDE.md` stays out of the published tree (session-local notes).
- [ ] `dist/` stays out of git. `packaging/release.sh` writes the tarball, checksum, and notes there.
- [ ] `package.json` is `"private": true` until a publish is approved. `npm publish` fails while that field is set.
- [ ] The Homebrew tap and the ghcr.io image are created only by the commands `release.sh` prints. The script does not run them.

## Portability gates

[review-12](../../design/reports/review-12.md) is the portability audit. These stay open until the owning step lands. Packaging does not close them.

| Item | Gate |
| --- | --- |
| R12-01 boot and discovery defaults select one machine's installation | G4 |
| R12-02 a discovered primary agent does not control commands, identity, or filtering | G3 |
| R12-03 unfamiliar channels lose classification and office presence | G3 |
| R12-04 the adapter boundary omits on-demand reads and leaks raw transport | G2 |
| R12-05 generic interlocutors need storage changes | G1 / G3 |
| R12-06 canonical identity changes before the 2.x compatibility layer | G3 |
| R12-07 browser name substitution does not repair server labels | G3 / G5 |
| R12-08 timezone is still a personal default | G4 |
| R12-09 the platform test is not a foreign-instance test | G3 |
| R12-10 plural workspace roots need a stable id | G4. Started in code behind `workspaceRootIds`, default off, until the contract says otherwise. |

The review's handoff table (G1 through G5) is the owner list. Do not start those steps from the packaging work.
