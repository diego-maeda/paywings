import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrCode } from '../src/brcode.ts';
import { createPayWings, monthStart, type PaymentRequest } from '../src/service.ts';

function setup(policy = {}, balance = 500_00) {
  let clock = new Date('2026-10-02T12:00:00Z');
  const m = createPayWings({ now: () => clock });
  const { apiKey } = m.createAgent('bot', { allowedMerchants: ['vercel.com', 'loja@exemplo.com'], ...policy }, balance);
  const advance = (ms: number) => (clock = new Date(clock.getTime() + ms));
  return { m, key: apiKey, advance };
}

const card = (over: Partial<PaymentRequest> = {}): PaymentRequest => ({
  amountCents: 20_00,
  rail: 'card',
  merchantName: 'Vercel',
  merchantDomain: 'vercel.com',
  category: 'software',
  justification: 'Upgrade to Pro plan requested by the user',
  idempotencyKey: `k-${Math.random()}`,
  ...over,
});

const balanceOf = (m: ReturnType<typeof createPayWings>) => m.listAgents()[0].balanceCents;

test('auto-approved card payment executes and debits the wallet', () => {
  const { m, key } = setup();
  const p = m.requestPayment(key, card());
  assert.equal(p.status, 'executed');
  assert.equal(p.execution?.type, 'card');
  if (p.execution?.type === 'card') {
    assert.equal(p.execution.locked_merchant, 'vercel.com');
    assert.equal(p.execution.limit_cents, 20_00);
  }
  assert.equal(balanceOf(m), 480_00);
});

test('payment above the threshold waits for a human, then executes on approval', () => {
  const { m, key } = setup();
  const p = m.requestPayment(key, card({ amountCents: 120_00 }));
  assert.equal(p.status, 'pending_approval');
  assert.equal(balanceOf(m), 500_00);
  assert.equal(m.listPending().length, 1);

  const approved = m.approve(p.id);
  assert.equal(approved.status, 'executed');
  assert.equal(balanceOf(m), 380_00);
  assert.equal(m.getPayment(key, p.id).status, 'executed');
});

test('rejected payments never execute', () => {
  const { m, key } = setup();
  const p = m.requestPayment(key, card({ amountCents: 120_00 }));
  assert.equal(m.reject(p.id, 'not now').status, 'rejected');
  assert.throws(() => m.approve(p.id), /rejected, not pending_approval/);
  assert.equal(balanceOf(m), 500_00);
});

test('approval re-checks the wallet: funds spent meanwhile are not double-used', () => {
  const { m, key } = setup({ approvalAboveCents: 50_00, maxPerTxCents: 500_00 }, 150_00);
  const big = m.requestPayment(key, card({ amountCents: 120_00 }));
  m.requestPayment(key, card({ amountCents: 50_00 }));
  const result = m.approve(big.id);
  assert.equal(result.status, 'denied');
  assert.deepEqual(result.reasons.map((r) => r.code), ['INSUFFICIENT_FUNDS']);
  assert.equal(balanceOf(m), 100_00);
});

test('same idempotency key replays the original result instead of paying twice', () => {
  const { m, key } = setup();
  const first = m.requestPayment(key, card({ idempotencyKey: 'order-1' }));
  const again = m.requestPayment(key, card({ idempotencyKey: 'order-1' }));
  assert.equal(again.id, first.id);
  assert.equal(again.replayed, true);
  assert.equal(balanceOf(m), 480_00);
  assert.throws(() => m.requestPayment(key, card({ idempotencyKey: 'order-1', amountCents: 30_00 })), /different parameters/);
});

test('pending payments count toward the monthly limit', () => {
  const { m, key } = setup({ monthlyLimitCents: 150_00 });
  m.requestPayment(key, card({ amountCents: 100_00 }));
  const second = m.requestPayment(key, card({ amountCents: 60_00 }));
  assert.equal(second.status, 'denied');
  assert.ok(second.reasons.some((r) => r.code === 'OVER_MONTHLY_LIMIT'));
});

test('velocity limit stops a looping agent', () => {
  const { m, key } = setup({ maxTxPerHour: 3 });
  for (let i = 0; i < 3; i++) assert.equal(m.requestPayment(key, card({ amountCents: 1_00 })).status, 'executed');
  assert.equal(m.requestPayment(key, card({ amountCents: 1_00 })).reasons[0].code, 'VELOCITY_LIMIT');
});

test('frozen agents cannot pay', () => {
  const { m, key } = setup();
  m.setStatus('bot', 'frozen');
  assert.equal(m.requestPayment(key, card()).reasons[0].code, 'AGENT_FROZEN');
});

test('pending approvals expire after 24 hours', () => {
  const { m, key, advance } = setup();
  const p = m.requestPayment(key, card({ amountCents: 120_00 }));
  advance(24 * 60 * 60 * 1000 + 1);
  assert.equal(m.getPayment(key, p.id).status, 'expired');
  assert.throws(() => m.approve(p.id), /expired/);
});

test('pix payee is taken from the BR Code, not from what the agent claims', () => {
  const { m, key } = setup();
  const scam = buildBrCode({ pixKey: 'golpista@fraude.com', merchantName: 'Loja Exemplo', merchantCity: 'Sao Paulo', amountCents: 35_90 });
  const p = m.requestPayment(key, {
    amountCents: 35_90,
    rail: 'pix',
    merchantName: 'Loja Exemplo',
    pixCode: scam,
    category: 'office_supplies',
    justification: 'Buying printer paper the user asked for',
    idempotencyKey: 'pix-1',
  });
  assert.equal(p.status, 'denied');
  assert.equal(p.payeeId, 'golpista@fraude.com');
  assert.deepEqual(p.reasons.map((r) => r.code), ['MERCHANT_NOT_ALLOWED']);
});

test('pix to an allowed key settles with an end-to-end id', () => {
  const { m, key } = setup();
  const code = buildBrCode({ pixKey: 'loja@exemplo.com', merchantName: 'Loja Exemplo', merchantCity: 'Sao Paulo', amountCents: 35_90 });
  const p = m.requestPayment(key, {
    amountCents: 35_90,
    rail: 'pix',
    merchantName: 'Loja Exemplo',
    pixCode: code,
    category: 'office_supplies',
    justification: 'Buying printer paper the user asked for',
    idempotencyKey: 'pix-2',
  });
  assert.equal(p.status, 'executed');
  assert.match(p.execution?.type === 'pix' ? p.execution.end_to_end_id : '', /^E00000000\d{12}[A-Z0-9]{11}$/);
});

test('pix amount must match the amount encoded in the code', () => {
  const { m, key } = setup();
  const code = buildBrCode({ pixKey: 'loja@exemplo.com', merchantName: 'Loja', merchantCity: 'Sao Paulo', amountCents: 10_00 });
  const p = m.requestPayment(key, {
    amountCents: 45_00,
    rail: 'pix',
    merchantName: 'Loja',
    pixCode: code,
    category: 'food',
    justification: 'Lunch order for the team',
    idempotencyKey: 'pix-3',
  });
  assert.deepEqual(p.reasons.map((r) => r.code), ['PIX_AMOUNT_MISMATCH']);
});

test('agents only see their own payments and need a valid key', () => {
  const { m, key } = setup();
  const p = m.requestPayment(key, card());
  const other = m.createAgent('other-bot', {}, 0);
  assert.throws(() => m.getPayment(other.apiKey, p.id), /not found/);
  assert.throws(() => m.requestPayment('pw_test_wrong', card()), /Invalid agent key/);
});

test('audit chain verifies and detects tampering', () => {
  const { m, key } = setup();
  m.requestPayment(key, card());
  m.requestPayment(key, card({ amountCents: 120_00 }));
  assert.equal(m.verifyAudit().ok, true);

  m.db.prepare("UPDATE audit SET body = replace(body, '2000', '200') WHERE event = 'payment.requested'").run();
  const result = m.verifyAudit();
  assert.equal(result.ok, false);
});

test('card numbers never reach the audit log', () => {
  const { m, key } = setup();
  const p = m.requestPayment(key, card());
  const number = p.execution?.type === 'card' ? p.execution.number : 'missing';
  const log = (m.db.prepare('SELECT body FROM audit').all() as Array<{ body: string }>).map((r) => r.body).join('\n');
  assert.ok(!log.includes(number));
  assert.ok(log.includes(number.slice(-4)));
});

test('dynamic pix codes always wait for a human, even small and to an allowed PSP', () => {
  const { m, key } = setup({ allowedMerchants: ['pix.psp-exemplo.com.br'] });
  const code = buildBrCode({
    locationUrl: 'pix.psp-exemplo.com.br/qr/v2/abc123',
    merchantName: 'Loja Exemplo',
    merchantCity: 'Sao Paulo',
    amountCents: 10_00,
  });
  const p = m.requestPayment(key, {
    amountCents: 10_00,
    rail: 'pix',
    merchantName: 'Loja Exemplo',
    pixCode: code,
    category: 'office_supplies',
    justification: 'Buying printer paper the user asked for',
    idempotencyKey: 'pix-dyn-1',
  });
  assert.equal(p.status, 'pending_approval');
  assert.deepEqual(p.reasons.map((r) => r.code), ['PAYEE_UNVERIFIED']);
  assert.equal(m.approve(p.id).status, 'executed');
});

test('the monthly limit resets at midnight in the configured time zone', () => {
  // 2026-11-01 01:00 UTC is still October 31 in São Paulo (UTC-3).
  let clock = new Date('2026-10-31T12:00:00Z');
  const m = createPayWings({ now: () => clock, timeZone: 'America/Sao_Paulo' });
  const { apiKey } = m.createAgent('bot', { monthlyLimitCents: 30_00 }, 500_00);
  assert.equal(m.requestPayment(apiKey, card({ amountCents: 20_00 })).status, 'executed');
  clock = new Date('2026-11-01T01:00:00Z');
  assert.deepEqual(m.requestPayment(apiKey, card({ amountCents: 20_00 })).reasons.map((r) => r.code), ['OVER_MONTHLY_LIMIT']);
  clock = new Date('2026-11-01T03:00:00Z');
  assert.equal(m.requestPayment(apiKey, card({ amountCents: 20_00 })).status, 'executed');
});

test('monthStart handles zones on both sides of UTC', () => {
  const at = new Date('2026-03-15T12:00:00Z');
  assert.equal(monthStart(at, 'America/Sao_Paulo').toISOString(), '2026-03-01T03:00:00.000Z');
  assert.equal(monthStart(at, 'UTC').toISOString(), '2026-03-01T00:00:00.000Z');
  assert.equal(monthStart(at, 'Asia/Tokyo').toISOString(), '2026-02-28T15:00:00.000Z');
});

test('the wallet stops counting expired approvals as pending', () => {
  const { m, key, advance } = setup();
  m.requestPayment(key, card({ amountCents: 80_00 }));
  assert.equal(m.getWallet(key).pending_approval, 'R$ 80,00');
  advance(25 * 60 * 60 * 1000);
  assert.equal(m.getWallet(key).pending_approval, 'R$ 0,00');
});
