# Connecting MCP clients

`paywings init` prints an agent key (`pw_test_...`). Every client below starts the same stdio server, `paywings mcp`, with two environment variables:

| Variable | Value |
| --- | --- |
| `PAYWINGS_AGENT_KEY` | the agent key, one per agent |
| `PAYWINGS_DB` | path to the sandbox database, default `~/.paywings/sandbox.db` |

Give each client only the **agent** key. The owner key never goes into a client configuration.

GUI apps often start without your shell's `PATH`. If the client can't find `paywings`, use the full path from `which paywings`, or `npx` with `"args": ["-y", "paywings", "mcp"]`.

## Claude Code

```bash
claude mcp add paywings --env PAYWINGS_AGENT_KEY=pw_test_... --env PAYWINGS_DB=$HOME/.paywings/sandbox.db -- paywings mcp
```

## Claude Desktop

Settings → Developer → Edit Config, then add to `claude_desktop_config.json` and restart the app:

```json
{
  "mcpServers": {
    "paywings": {
      "command": "paywings",
      "args": ["mcp"],
      "env": {
        "PAYWINGS_AGENT_KEY": "pw_test_...",
        "PAYWINGS_DB": "/Users/you/.paywings/sandbox.db"
      }
    }
  }
}
```

## Cursor

Add the same `mcpServers` block to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project). Don't commit a file that contains the agent key.

## Try it

Ask the agent something that needs a purchase, for example:

- "Check my PayWings wallet and tell me what I can spend this month."
- "Upgrade my Vercel plan to Pro (R$ 100)." With the default policy this waits for your approval: run `paywings pending`, then `paywings approve pay_...`.
- "Pay this Pix code: 000201..." Generate a test code with `paywings pix-code --key loja@exemplo.com --name Loja --city "Sao Paulo" --amount 35,90`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Invalid agent key` when the server starts | The key doesn't match the database in `PAYWINGS_DB`; both must come from the same `init` |
| The client lists no PayWings tools | Check the client's MCP logs; usually `paywings` isn't on its `PATH` |
| `paywings requires Node 22.18 or newer` | Update Node; GUI apps may use a different Node than your shell |
