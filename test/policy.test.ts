import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, evaluate, type EvalInput } from '../src/policy.ts';

const base: EvalInput = {
  agentActive: true,
  policy: { ...DEFAULT_POLICY, allowedMerchants: ['vercel.com'] },
  amountCents: 20_00,
  rail: 'card',
  category: 'software',
  payeeId: 'vercel.com',
  instrumentErrors: [],
  balanceCents: 500_00,
  monthCommittedCents: 0,
  txLastHour: 0,
};

const codes = (input: Partial<EvalInput>) => evaluate({ ...base, ...input }).reasons.map((r) => r.code);

test('approves a small payment to an allowed merchant', () => {
  assert.deepEqual(evaluate(base), { outcome: 'approved', reasons: [] });
});

test('subdomains of an allowed merchant are allowed, lookalikes are not', () => {
  assert.equal(evaluate({ ...base, payeeId: 'api.vercel.com' }).outcome, 'approved');
  assert.deepEqual(codes({ payeeId: 'vercel.com.evil.io' }), ['MERCHANT_NOT_ALLOWED']);
  assert.deepEqual(codes({ payeeId: 'notvercel.com' }), ['MERCHANT_NOT_ALLOWED']);
});

test('above the threshold needs a human, unless already approved', () => {
  assert.equal(evaluate({ ...base, amountCents: 80_00 }).outcome, 'pending_approval');
  assert.equal(evaluate({ ...base, amountCents: 80_00, humanApproved: true }).outcome, 'approved');
});

test('reports every failing rule at once', () => {
  assert.deepEqual(
    codes({ agentActive: false, amountCents: 300_00, category: 'Gambling', monthCommittedCents: 900_00, txLastHour: 10, balanceCents: 100 }),
    ['AGENT_FROZEN', 'CATEGORY_BLOCKED', 'OVER_TX_LIMIT', 'OVER_MONTHLY_LIMIT', 'VELOCITY_LIMIT', 'INSUFFICIENT_FUNDS'],
  );
});

test('card payments without a merchant domain are denied', () => {
  assert.deepEqual(codes({ payeeId: null }), ['MERCHANT_REQUIRED']);
});

test('disallowed rail is denied', () => {
  assert.deepEqual(codes({ rail: 'pix', policy: { ...base.policy, allowedRails: ['card'] } }), ['RAIL_NOT_ALLOWED']);
});

test('an empty allow list accepts any payee', () => {
  assert.equal(evaluate({ ...base, payeeId: 'anything.com', policy: { ...base.policy, allowedMerchants: [] } }).outcome, 'approved');
});

test('an unverified payee goes to a human even below the threshold', () => {
  const d = evaluate({ ...base, amountCents: 10_00, payeeUnverified: true });
  assert.equal(d.outcome, 'pending_approval');
  assert.deepEqual(d.reasons.map((r) => r.code), ['PAYEE_UNVERIFIED']);
});
