import { randomInt } from 'node:crypto';

export type CardExecution = {
  type: 'card';
  card_id: string;
  number: string;
  exp_month: number;
  exp_year: number;
  cvc: string;
  locked_merchant: string;
  limit_cents: number;
  expires_at: string;
  sandbox: true;
};

export type PixExecution = {
  type: 'pix';
  end_to_end_id: string;
  payee: { key?: string; location?: string; name: string; city: string };
  amount_cents: number;
  settled_at: string;
  sandbox: true;
};

export type Execution = CardExecution | PixExecution;

/** A rail adapter. Production adapters call the issuer / PSP; the sandbox fabricates results. */
export type Rails = {
  issueCard(req: { merchantDomain: string; amountCents: number; now: Date }): CardExecution;
  payPix(req: {
    payee: PixExecution['payee'];
    amountCents: number;
    now: Date;
  }): PixExecution;
};

const CARD_TTL_MS = 30 * 60 * 1000;
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function luhnCheckDigit(partial: string): number {
  let sum = 0;
  for (let i = 0; i < partial.length; i++) {
    let d = Number(partial[partial.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

function randomDigits(n: number): string {
  return Array.from({ length: n }, () => randomInt(10)).join('');
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:T]/g, '').slice(0, 12);
}

export const sandboxRails: Rails = {
  issueCard({ merchantDomain, amountCents, now }) {
    // 411111 is the industry-standard test BIN; these numbers never authorize on a real network.
    const partial = `411111${randomDigits(9)}`;
    const expires = new Date(now.getTime() + CARD_TTL_MS);
    return {
      type: 'card',
      card_id: `card_${randomDigits(12)}`,
      number: partial + luhnCheckDigit(partial),
      exp_month: expires.getUTCMonth() + 1,
      exp_year: expires.getUTCFullYear() + 1,
      cvc: randomDigits(3),
      locked_merchant: merchantDomain,
      limit_cents: amountCents,
      expires_at: expires.toISOString(),
      sandbox: true,
    };
  },

  payPix({ payee, amountCents, now }) {
    const suffix = Array.from({ length: 11 }, () => ALNUM[randomInt(ALNUM.length)]).join('');
    return {
      type: 'pix',
      // E + payer ISPB (00000000 in sandbox) + yyyyMMddHHmm + 11 chars, per the Pix E2E format.
      end_to_end_id: `E00000000${stamp(now)}${suffix}`,
      payee,
      amount_cents: amountCents,
      settled_at: now.toISOString(),
      sandbox: true,
    };
  },
};

/** Strips secrets before an execution is written to the audit log. */
export function redactExecution(execution: Execution): Record<string, unknown> {
  if (execution.type === 'card') {
    const { number, cvc, ...rest } = execution;
    return { ...rest, last4: number.slice(-4) };
  }
  return { ...execution };
}
