export const DEFAULT_POLICY = {
    maxPerTxCents: 200_00,
    monthlyLimitCents: 1_000_00,
    approvalAboveCents: 50_00,
    maxTxPerHour: 10,
    allowedRails: ['card', 'pix'],
    allowedMerchants: [],
    blockedCategories: ['gambling', 'crypto', 'gift_cards'],
};
export function normalizePayee(value) {
    return value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}
function payeeAllowed(payeeId, allowed) {
    const payee = normalizePayee(payeeId);
    return allowed.some((entry) => {
        const rule = normalizePayee(entry);
        return payee === rule || payee.endsWith(`.${rule}`);
    });
}
/** Pure policy evaluation. Every failing rule is reported so the agent can explain or adjust. */
export function evaluate(input) {
    const { policy } = input;
    const reasons = [];
    const deny = (code, message) => reasons.push({ code, message });
    if (!input.agentActive)
        deny('AGENT_FROZEN', 'Agent is frozen by its owner');
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
        deny('INVALID_AMOUNT', 'Amount must be a positive number of cents');
    }
    if (!policy.allowedRails.includes(input.rail))
        deny('RAIL_NOT_ALLOWED', `Rail "${input.rail}" is not allowed`);
    reasons.push(...input.instrumentErrors);
    if (!input.payeeId) {
        deny('MERCHANT_REQUIRED', input.rail === 'card' ? 'Card payments need merchant_domain' : 'Payee could not be identified');
    }
    else if (policy.allowedMerchants.length > 0 && !payeeAllowed(input.payeeId, policy.allowedMerchants)) {
        deny('MERCHANT_NOT_ALLOWED', `Payee "${input.payeeId}" is not in the allowed list`);
    }
    if (policy.blockedCategories.includes(input.category.toLowerCase())) {
        deny('CATEGORY_BLOCKED', `Category "${input.category}" is blocked`);
    }
    if (input.amountCents > policy.maxPerTxCents)
        deny('OVER_TX_LIMIT', 'Amount exceeds the per-transaction limit');
    if (input.monthCommittedCents + input.amountCents > policy.monthlyLimitCents) {
        deny('OVER_MONTHLY_LIMIT', 'Amount would exceed the monthly limit (pending payments count)');
    }
    if (input.txLastHour >= policy.maxTxPerHour)
        deny('VELOCITY_LIMIT', 'Too many payments in the last hour');
    if (input.amountCents > input.balanceCents)
        deny('INSUFFICIENT_FUNDS', 'Wallet balance is too low');
    if (reasons.length > 0)
        return { outcome: 'denied', reasons };
    if (!input.humanApproved && input.amountCents > policy.approvalAboveCents) {
        return {
            outcome: 'pending_approval',
            reasons: [{ code: 'NEEDS_HUMAN_APPROVAL', message: 'Amount is above the auto-approval threshold' }],
        };
    }
    return { outcome: 'approved', reasons: [] };
}
