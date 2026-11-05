import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AmountError, toCents } from './money.ts';
import { cardStillValid, PayWingsError, toView, type PayWings } from './service.ts';
import { VERSION } from './version.ts';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function guard(fn: () => unknown): ToolResult {
  try {
    return ok(fn());
  } catch (err) {
    if (err instanceof PayWingsError || err instanceof AmountError) {
      const code = err instanceof PayWingsError ? err.code : 'INVALID_AMOUNT';
      return { content: [{ type: 'text', text: JSON.stringify({ error: code, message: err.message }) }], isError: true };
    }
    throw err;
  }
}

/**
 * Agent-facing MCP server. It only exposes agent-scope operations: approving, topping up
 * and changing policy are owner actions and deliberately have no tool here.
 */
export function createMcpServer(paywings: PayWings, apiKey: string | undefined, now: () => Date = () => new Date()) {
  const server = new McpServer({ name: 'paywings', version: VERSION });

  server.registerTool(
    'get_wallet',
    {
      title: 'Get wallet',
      description:
        'Shows the balance, spending limits and allowed merchants for this agent. Call it before planning a purchase.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => guard(() => paywings.getWallet(apiKey)),
  );

  server.registerTool(
    'request_payment',
    {
      title: 'Request payment',
      description: [
        'Requests a payment on behalf of the user. The server checks it against the owner policy and returns one of:',
        'executed (a single-use card or a Pix receipt is returned), pending_approval (a human must approve; poll get_payment),',
        'or denied (reasons explain why). Use rail "card" with merchant_domain for websites and APIs,',
        'or rail "pix" with the Pix copia-e-cola code. Reuse the same idempotency_key when retrying the same purchase.',
      ].join(' '),
      inputSchema: {
        amount: z.number().positive().describe('Amount in BRL, e.g. 49.90'),
        rail: z.enum(['card', 'pix']),
        merchant_name: z.string().min(1).describe('Who is being paid, as shown to the user'),
        merchant_domain: z.string().optional().describe('Required for card: the website domain, e.g. vercel.com'),
        pix_code: z.string().optional().describe('Required for pix: the full BR Code (copia e cola)'),
        category: z.string().min(1).describe('e.g. software, travel, food, office_supplies'),
        justification: z.string().min(10).describe('Why this purchase serves the user request; shown to the owner'),
        idempotency_key: z.string().min(8).describe('Unique per purchase; reuse it on retries'),
      },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(() => {
        const payment = paywings.requestPayment(apiKey, {
          amountCents: toCents(args.amount),
          rail: args.rail,
          merchantName: args.merchant_name,
          merchantDomain: args.merchant_domain,
          pixCode: args.pix_code,
          category: args.category,
          justification: args.justification,
          idempotencyKey: args.idempotency_key,
        });
        return { ...toView(payment, { revealCard: cardStillValid(payment, now()) }), replayed: payment.replayed };
      }),
  );

  server.registerTool(
    'get_payment',
    {
      title: 'Get payment',
      description: 'Returns the current status of a payment created by this agent (use it after pending_approval).',
      inputSchema: { payment_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ payment_id }) =>
      guard(() => {
        const payment = paywings.getPayment(apiKey, payment_id);
        return toView(payment, { revealCard: cardStillValid(payment, now()) });
      }),
  );

  server.registerTool(
    'list_payments',
    {
      title: 'List payments',
      description: 'Lists the most recent payments created by this agent. Card numbers are hidden.',
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) =>
      guard(() => paywings.listMyPayments(apiKey, limit ?? 10).map((p) => toView(p, { revealCard: false }))),
  );

  return server;
}
