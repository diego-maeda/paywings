# Changelog

## Unreleased

- Owner key for owner commands; `approve` keeps the TTY check.
- Dynamic Pix codes always need human approval (`PAYEE_UNVERIFIED`).
- Monthly limit resets at midnight in `PAYWINGS_TZ` (default `America/Sao_Paulo`).
- Published as an npm package with a compiled `dist/`; CI on Node 22.18 and 24.
- `SECURITY.md` and a guide for Claude Desktop and Cursor.

## 0.1.0 — 2026-10-02

- Policy-governed payments sandbox: policy engine, approvals, simulated card and Pix rails, hash-chained audit log, MCP server and CLI.
