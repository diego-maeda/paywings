import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp.ts';
import { createPayWings } from '../src/service.ts';

async function connect() {
  const m = createPayWings();
  const { apiKey } = m.createAgent('bot', { allowedMerchants: ['vercel.com'] }, 500_00);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(m, apiKey).connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return { m, client };
}

const parse = (result: Awaited<ReturnType<Client['callTool']>>) =>
  JSON.parse((result.content as Array<{ text: string }>)[0].text);

test('exposes only agent-scope tools', async () => {
  const { client } = await connect();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['get_payment', 'get_wallet', 'list_payments', 'request_payment']);
});

test('request_payment returns a usable single-use card and next step', async () => {
  const { client } = await connect();
  const result = parse(
    await client.callTool({
      name: 'request_payment',
      arguments: {
        amount: 19.9,
        rail: 'card',
        merchant_name: 'Vercel',
        merchant_domain: 'vercel.com',
        category: 'software',
        justification: 'User asked to upgrade the Vercel plan',
        idempotency_key: 'upgrade-2026-10',
      },
    }),
  );
  assert.equal(result.status, 'executed');
  assert.equal(result.amount, 'R$ 19,90');
  assert.match(result.execution.number, /^411111\d{10}$/);
  assert.match(result.next_step, /single-use card only at vercel.com/);
});

test('list_payments hides card numbers', async () => {
  const { client } = await connect();
  await client.callTool({
    name: 'request_payment',
    arguments: {
      amount: 10,
      rail: 'card',
      merchant_name: 'Vercel',
      merchant_domain: 'vercel.com',
      category: 'software',
      justification: 'User asked to buy extra build minutes',
      idempotency_key: 'minutes-1',
    },
  });
  const [listed] = parse(await client.callTool({ name: 'list_payments', arguments: {} }));
  assert.equal(listed.execution.number, undefined);
  assert.match(listed.execution.last4, /^\d{4}$/);
});

test('domain errors come back as tool errors, not crashes', async () => {
  const { client } = await connect();
  const result = await client.callTool({ name: 'get_payment', arguments: { payment_id: 'pay_nope' } });
  assert.equal(result.isError, true);
  assert.equal(parse(result).error, 'PAYMENT_NOT_FOUND');
});
