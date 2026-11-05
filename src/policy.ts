export type Rail = 'card' | 'pix';

export type Policy = {
  maxPerTxCents: number;
  monthlyLimitCents: number;
  approvalAboveCents: number;
  maxTxPerHour: number;
  allowedRails: Rail[];
  /** Card: domains (subdomains match). Pix: keys or location hosts. Empty = any payee. */
  allowedMerchants: string[];
  blockedCategories: string[];
};

export const DEFAULT_POLICY: Policy = {
  maxPerTxCents: 200_00,
  monthlyLimitCents: 1_000_00,
  approvalAboveCents: 50_00,
  maxTxPerHour: 10,
  allowedRails: ['card', 'pix'],
  allowedMerchants: [],
  blockedCategories: ['gambling', 'crypto', 'gift_cards'],
};

export type ReasonCode =
  | 'AGENT_FROZEN'
  | 'INVALID_AMOUNT'
  | 'RAIL_NOT_ALLOWED'
  | 'PIX_CODE_INVALID'
  | 'PIX_AMOUNT_MISMATCH'
  | 'MERCHANT_REQUIRED'
  | 'MERCHANT_NOT_ALLOWED'
  | 'CATEGORY_BLOCKED'
  | 'OVER_TX_LIMIT'
  | 'OVER_MONTHLY_LIMIT'
  | 'VELOCITY_LIMIT'
  | 'INSUFFICIENT_FUNDS'
  | 'NEEDS_HUMAN_APPROVAL'
  | 'PAYEE_UNVERIFIED';

export type Reason = { code: ReasonCode; message: string };

export type EvalInput = {
  agentActive: boolean;
  policy: Policy;
  amountCents: number;
  rail: Rail;
  category: string;
  /** Payee identity the policy is checked against; for Pix it comes from the BR Code, not the agent. */
  payeeId: string | null;
  /** Errors found while decoding the payment instrument (e.g. an invalid BR Code). */
  instrumentErrors: Reason[];
  balanceCents: number;
  /** Executed + pending this month, excluding the request being evaluated. */
  monthCommittedCents: number;
  txLastHour: number;
  /**
   * Set when the instrument doesn't name the final payee (a dynamic Pix code only names the
   * PSP host). Such payments always go to a human, whatever the amount.
   */
  payeeUnverified?: boolean;
  /** Set when a human already approved; the approval threshold no longer applies. */
  humanApproved?: boolean;
};

export type Decision = {
  outcome: 'approved' | 'pending_approval' | 'denied';
  reasons: Reason[];
};

export function normalizePayee(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}

function payeeAllowed(payeeId: string, allowed: string[]): boolean {
  const payee = normalizePayee(payeeId);
  return allowed.some((entry) => {
    const rule = normalizePayee(entry);
    return payee === rule || payee.endsWith(`.${rule}`);
  });
}

/** Pure policy evaluation. Every failing rule is reported so the agent can explain or adjust. */
export function evaluate(input: EvalInput): Decision {
  const { policy } = input;
  const reasons: Reason[] = [];
  const deny = (code: ReasonCode, message: string) => reasons.push({ code, message });

  if (!input.agentActive) deny('AGENT_FROZEN', 'Agent is frozen by its owner');
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    deny('INVALID_AMOUNT', 'Amount must be a positive number of cents');
  }
  if (!policy.allowedRails.includes(input.rail)) deny('RAIL_NOT_ALLOWED', `Rail "${input.rail}" is not allowed`);
  reasons.push(...input.instrumentErrors);

  if (!input.payeeId) {
    deny('MERCHANT_REQUIRED', input.rail === 'card' ? 'Card payments need merchant_domain' : 'Payee could not be identified');
  } else if (policy.allowedMerchants.length > 0 && !payeeAllowed(input.payeeId, policy.allowedMerchants)) {
    deny('MERCHANT_NOT_ALLOWED', `Payee "${input.payeeId}" is not in the allowed list`);
  }

  if (policy.blockedCategories.includes(input.category.toLowerCase())) {
    deny('CATEGORY_BLOCKED', `Category "${input.category}" is blocked`);
  }
  if (input.amountCents > policy.maxPerTxCents) deny('OVER_TX_LIMIT', 'Amount exceeds the per-transaction limit');
  if (input.monthCommittedCents + input.amountCents > policy.monthlyLimitCents) {
    deny('OVER_MONTHLY_LIMIT', 'Amount would exceed the monthly limit (pending payments count)');
  }
  if (input.txLastHour >= policy.maxTxPerHour) deny('VELOCITY_LIMIT', 'Too many payments in the last hour');
  if (input.amountCents > input.balanceCents) deny('INSUFFICIENT_FUNDS', 'Wallet balance is too low');

  if (reasons.length > 0) return { outcome: 'denied', reasons };
  if (input.humanApproved) return { outcome: 'approved', reasons: [] };
  const needs: Reason[] = [];
  if (input.amountCents > policy.approvalAboveCents) {
    needs.push({ code: 'NEEDS_HUMAN_APPROVAL', message: 'Amount is above the auto-approval threshold' });
  }
  if (input.payeeUnverified) {
    needs.push({
      code: 'PAYEE_UNVERIFIED',
      message: 'Dynamic Pix code: only the PSP is known, not the final payee, so a human must confirm it',
    });
  }
  if (needs.length > 0) return { outcome: 'pending_approval', reasons: needs };
  return { outcome: 'approved', reasons: [] };
}
