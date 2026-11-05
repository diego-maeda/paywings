# Contributing

## Setup

Node 22.18 or newer.

```bash
npm install
npm test               # unit tests
npm run typecheck
npm run smoke:package  # packs and installs the package, then runs the CLI
npm run paywings -- --help   # run the CLI from source
```

## Commits and pull requests

Pull requests are squash-merged, so the **PR title** becomes the commit on `main` and drives the next version.
Use [Conventional Commits](https://www.conventionalcommits.org):

| Type | Use for | Release |
| --- | --- | --- |
| `feat:` | new behavior | minor |
| `fix:` | bug fix | patch |
| `sec:` | security fix | patch |
| `perf:` | performance | patch |
| `docs:`, `test:`, `ci:`, `chore:`, `refactor:` | everything else | none |

Add `!` after the type (`feat!:`) or a `BREAKING CHANGE:` footer when you change the
[public API](docs/VERSIONING.md#public-api).

## Releases

A bot keeps a "release PR" open with the next version and changelog. Merging it tags the release and publishes
to npm. Pull requests opened by the bot do not trigger CI; the commits they contain already passed CI on `main`.
