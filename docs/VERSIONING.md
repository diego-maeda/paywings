# Versioning

PayWings follows [Semantic Versioning](https://semver.org). Releases, tags (`vX.Y.Z`) and the
[changelog](../CHANGELOG.md) are generated from [Conventional Commits](https://www.conventionalcommits.org).

## Public API

Changes to any of these follow the rules below:

- CLI commands, flags and exit codes
- JSON printed by `paywings pay` and `paywings status`
- MCP tool names, input parameters and response fields
- Reason codes returned on denied payments (for example `MERCHANT_NOT_ALLOWED`)
- Environment variables (`PAYWINGS_DB`, `PAYWINGS_AGENT_KEY`)
- Agent key prefix (`pw_test_`)
- Database file compatibility: a newer version always opens a database created by an older one

Not part of the public API: modules under `src/`, human-readable messages, and the database table layout.

## Before 1.0 (current)

| Change | Version bump |
| --- | --- |
| Bug or security fix (`fix:`, `sec:`) | patch: `0.1.0` → `0.1.1` |
| New feature (`feat:`) | minor: `0.1.0` → `0.2.0` |
| Breaking change (`feat!:`, `BREAKING CHANGE:`) | minor, called out in the changelog |

A patch release never breaks the public API. Pin a minor range (`~0.1.0`) to avoid surprises.

## From 1.0 on

Breaking changes require a major version. Deprecated behavior keeps working for at least one minor release.
