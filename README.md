# PayWings

Policy-governed payments for AI agents. Agents pay through MCP or the terminal, and only within rules their human owner sets.

[Leia em português](README.pt-BR.md) · [Design spec (pt-BR)](SPEC.md)

> **Sandbox only.** No real money moves. Cards use the 411111 test BIN and Pix settlement is simulated.

## Why

Prompt injection can talk an agent into anything, so spending rules can't live inside the agent. PayWings keeps them on the server:

- **The agent asks, the server decides.** Every purchase is a payment intent evaluated by a deterministic policy engine. The agent has no tool to approve, top up, or change limits.
- **The data decides, not the agent's claim.** For Pix, the payee is read from the BR Code itself. A code that says "Trusted Store" but points to someone else's key is denied.
- **Minimal exposure.** Cards are single-use, locked to one merchant and amount, and expire after 30 minutes.
- **Humans approve out of band.** Payments above a threshold wait for the owner. In the sandbox, `approve` requires an interactive terminal, which an agent running shell commands doesn't have.
- **Everything is auditable.** Every event goes into an append-only, hash-chained log: intent, decision, approval, execution. Card numbers never reach the log.

## Install

Requires Node 22.18 or newer.

```bash
npm install --global paywings
paywings init       # creates ~/.paywings/sandbox.db with a "demo" agent and R$ 500.00
```

Or run without installing: `npx paywings init`. In that case, end the `claude mcp add` command that `init`
prints with `-- npx -y paywings mcp` instead of `-- paywings mcp`. Versions follow
[semver](docs/VERSIONING.md); see the [changelog](CHANGELOG.md).

## Connect an agent

`paywings init` prints the agent key and a ready-made command to register the MCP server with Claude Code:

```bash
claude mcp add paywings --env PAYWINGS_AGENT_KEY=pw_test_... --env PAYWINGS_DB=~/.paywings/sandbox.db -- paywings mcp
```

Then ask your agent to, for example, "upgrade my Vercel plan". It calls `request_payment` and gets back one of three results:

- `executed`, with a single-use card or a Pix receipt;
- `pending_approval`, while it waits for you;
- `denied`, with machine-readable reasons.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `get_wallet` | Balance, limits, month-to-date spend, allowed merchants |
| `request_payment` | Ask to pay by `card` (with `merchant_domain`) or `pix` (with the copia-e-cola code); requires an `idempotency_key` and a `justification` |
| `get_payment` | Poll a payment after `pending_approval` |
| `list_payments` | Recent payments, with card numbers hidden |

## Policy

Each agent has its own policy, checked in this order:

1. Kill switch: is the agent frozen?
2. Allowed rails.
3. Pix code validity, and the amount encoded in it.
4. Merchant allow-list. A domain also matches its subdomains, but lookalikes such as `vercel.com.evil.io` don't match.
5. Blocked categories.
6. Per-transaction limit.
7. Monthly limit. Pending payments count toward it. Months start at midnight in `PAYWINGS_TZ` (default `America/Sao_Paulo`).
8. Payments per hour.
9. Balance.
10. Human-approval threshold. Dynamic Pix codes (which name only the PSP, not the final payee) always go to a human.

All failing rules are reported at once.

## Owner commands

```bash
paywings agents create research --balance 300 --per-tx 100 --monthly 500 --approve-above 30 --merchants vercel.com,openai.com
paywings pending
paywings approve pay_...          # interactive terminal; you type the amount to confirm
paywings reject pay_... --note "not now"
paywings agents freeze research   # kill switch
paywings audit verify             # checks the hash chain
```

## Agent commands (terminal)

```bash
export PAYWINGS_AGENT_KEY=pw_test_...
paywings pay --amount 19.90 --rail card --merchant Vercel --domain vercel.com --category software --reason "upgrade requested by the user"
paywings pay --amount 35.90 --rail pix --merchant Store --pix "$(paywings pix-code --key store@example.com --name Store --city 'Sao Paulo' --amount 35.90)" --category office --reason "..."
paywings status pay_...
```

CLI output is in Portuguese for now. `pay` and `status` print JSON.

## Development

```bash
npm install
npm test
npm run typecheck
npm run smoke:package
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for commit and release conventions.

| File | Role |
| --- | --- |
| `src/policy.ts` | Policy engine (pure function) |
| `src/service.ts` | Wallets, payments, approvals, idempotency, audit log (SQLite, `BEGIN IMMEDIATE` transactions) |
| `src/brcode.ts` | Pix BR Code parser and builder with CRC16 validation |
| `src/rails/sandbox.ts` | Simulated rails; production adapters implement the same `Rails` interface |
| `src/mcp.ts` | Agent-facing MCP server |
| `src/cli.ts` | Owner and agent CLI |

## Roadmap

1. **Sandbox (this repo):** policies, approvals, Pix and card simulation, audit log.
2. **Real money, small volume:**
   - cards through a BaaS issuer or Stripe Issuing;
   - Pix through a licensed payment initiator (Open Finance);
   - REST API, WhatsApp approvals, web dashboard.
3. **Network protocols:** agentic tokens from the card networks, ACP/AP2, x402.

## License

[Apache-2.0](LICENSE)
