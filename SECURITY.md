# Security

PayWings is a **sandbox**. No real money moves, and the threat model below describes what the sandbox does and does not protect against today.

## Reporting a vulnerability

Please open a [private security advisory](https://github.com/diego-maeda/paywings/security/advisories/new) instead of a public issue. Include steps to reproduce and the commit you tested.

## What the sandbox protects against

| Threat | Protection |
| --- | --- |
| Prompt injection tells the agent to pay someone else | Payee allow-list; for Pix, the payee is read from the BR Code, not from the agent's text |
| The agent approves its own payment or raises its limits | No MCP tool for it; owner CLI commands need an owner key the agent never receives; `approve` also needs a TTY |
| A looping agent creates many payments | Per-hour limit, monthly limit counting pending payments, mandatory idempotency key |
| A card number leaks | Single-use, locked to one merchant and amount, expires in 30 minutes; never written to the audit log |
| A dynamic Pix code hides the final payee | Always sent to a human (`PAYEE_UNVERIFIED`) |
| Two processes spend the same balance | Policy check and debit run in one `BEGIN IMMEDIATE` SQLite transaction |

## Known limits

- **The database is a local file.** `~/.paywings/sandbox.db` belongs to your OS user. An agent that runs shell commands as that user can edit balances and policies in the file directly, bypassing the CLI. Treat the sandbox as a way to test agent behaviour, not as a security boundary against a hostile agent. Moving the policy out of the agent's reach (a hosted API or a daemon under a separate user) is on the roadmap.
- **The audit hash chain is tamper-evident, not tamper-proof.** Anyone who can write the database can recompute every hash.
- **Card data is stored in plain text** in the `payments` table. Sandbox cards use the 411111 test BIN and never authorize anywhere; production will store only issuer tokens.
- **The merchant category is declared by the agent.** In production, cards will be locked by MCC at the issuer.

## Handling the owner key

- `paywings init` prints it once. Store it in a password manager.
- Type it at the prompt, or pipe it from a password manager (`op read ... | paywings topup demo 100`).
- Never export it as an environment variable or save it in a file the agent can read. Agents usually inherit the owner's environment.
