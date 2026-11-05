import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { BrCodeError, parseBrCode } from './brcode.ts';
import { formatBRL } from './money.ts';
import { DEFAULT_POLICY, evaluate, normalizePayee, type Policy, type Rail, type Reason } from './policy.ts';
import { redactExecution, sandboxRails, type Execution, type Rails } from './rails/sandbox.ts';

export class PayWingsError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type AgentStatus = 'active' | 'frozen';
export type PaymentStatus = 'denied' | 'pending_approval' | 'executed' | 'rejected' | 'expired';

export type Agent = {
  id: string;
  name: string;
  status: AgentStatus;
  balanceCents: number;
  policy: Policy;
  createdAt: string;
};

export type Merchant = {
  /** Name the agent declared. */
  declaredName: string;
  domain?: string;
  /** Pix payee data, taken from the BR Code rather than from the agent. */
  pixKey?: string;
  pixLocation?: string;
  pixName?: string;
  pixCity?: string;
};

export type Payment = {
  id: string;
  agentId: string;
  idempotencyKey: string;
  amountCents: number;
  rail: Rail;
  payeeId: string | null;
  merchant: Merchant;
  category: string;
  justification: string;
  status: PaymentStatus;
  reasons: Reason[];
  execution: Execution | null;
  createdAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
};

export type PaymentRequest = {
  amountCents: number;
  rail: Rail;
  merchantName: string;
  merchantDomain?: string;
  pixCode?: string;
  category: string;
  justification: string;
  idempotencyKey: string;
};

export type PaymentView = ReturnType<typeof toView>;

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const GENESIS = '0'.repeat(64);

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL,
  key_hash TEXT UNIQUE NOT NULL,
  balance_cents INTEGER NOT NULL CHECK (balance_cents >= 0),
  policy TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  rail TEXT NOT NULL,
  payee_id TEXT,
  merchant TEXT NOT NULL,
  category TEXT NOT NULL,
  justification TEXT NOT NULL,
  status TEXT NOT NULL,
  reasons TEXT NOT NULL,
  execution TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  decided_at TEXT,
  UNIQUE (agent_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS payments_agent_created ON payments (agent_id, created_at);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  event TEXT NOT NULL,
  body TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

function rowToAgent(r: Row): Agent {
  return {
    id: r.id as string,
    name: r.name as string,
    status: r.status as AgentStatus,
    balanceCents: r.balance_cents as number,
    policy: JSON.parse(r.policy as string),
    createdAt: r.created_at as string,
  };
}

function rowToPayment(r: Row): Payment {
  return {
    id: r.id as string,
    agentId: r.agent_id as string,
    idempotencyKey: r.idempotency_key as string,
    amountCents: r.amount_cents as number,
    rail: r.rail as Rail,
    payeeId: (r.payee_id as string | null) ?? null,
    merchant: JSON.parse(r.merchant as string),
    category: r.category as string,
    justification: r.justification as string,
    status: r.status as PaymentStatus,
    reasons: JSON.parse(r.reasons as string),
    execution: r.execution ? JSON.parse(r.execution as string) : null,
    createdAt: r.created_at as string,
    expiresAt: (r.expires_at as string | null) ?? null,
    decidedAt: (r.decided_at as string | null) ?? null,
  };
}

function nextStep(p: Payment): string {
  switch (p.status) {
    case 'executed':
      return p.execution?.type === 'card'
        ? `Use this single-use card only at ${p.execution.locked_merchant}, for up to ${formatBRL(p.execution.limit_cents)}, before ${p.execution.expires_at}.`
        : 'Pix settled. Share the end_to_end_id with the merchant if they ask for proof.';
    case 'pending_approval':
      return `Waiting for the human owner to approve (paywings approve ${p.id}). Tell the user, then check again with get_payment. Do not create a new payment.`;
    case 'denied':
      return 'Denied by policy. Do not retry with the same parameters; explain the reasons to the user.';
    case 'rejected':
      return 'The owner rejected this payment. Do not retry without asking the user.';
    case 'expired':
      return 'Approval window expired. Ask the user before requesting again.';
  }
}

export function toView(p: Payment, opts: { revealCard: boolean }) {
  let execution: Record<string, unknown> | null = null;
  if (p.execution) execution = opts.revealCard ? { ...p.execution } : redactExecution(p.execution);
  return {
    id: p.id,
    status: p.status,
    amount: formatBRL(p.amountCents),
    amount_cents: p.amountCents,
    rail: p.rail,
    payee: p.payeeId,
    merchant: p.merchant,
    category: p.category,
    justification: p.justification,
    reasons: p.reasons,
    execution,
    created_at: p.createdAt,
    expires_at: p.expiresAt,
    decided_at: p.decidedAt,
    next_step: nextStep(p),
  };
}

export type PayWingsOptions = {
  path?: string;
  now?: () => Date;
  rails?: Rails;
};

export function createPayWings(opts: PayWingsOptions = {}) {
  const path = opts.path ?? ':memory:';
  const now = opts.now ?? (() => new Date());
  const rails = opts.rails ?? sandboxRails;
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  // BEGIN IMMEDIATE takes the write lock up front, so policy checks and the debit
  // happen atomically even when the MCP server and the CLI run as separate processes.
  function tx<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function audit(actor: string, event: string, data: Record<string, unknown>) {
    const last = db.prepare('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1').get() as Row | undefined;
    const prev = (last?.hash as string) ?? GENESIS;
    const body = JSON.stringify({ at: now().toISOString(), actor, event, data });
    db.prepare('INSERT INTO audit (actor, event, body, prev_hash, hash) VALUES (?, ?, ?, ?, ?)').run(
      actor,
      event,
      body,
      prev,
      sha256(prev + body),
    );
  }

  function agentByName(name: string): Agent {
    const row = db.prepare('SELECT * FROM agents WHERE name = ?').get(name) as Row | undefined;
    if (!row) throw new PayWingsError('AGENT_NOT_FOUND', `Agent "${name}" not found`);
    return rowToAgent(row);
  }

  function agentById(id: string): Agent {
    return rowToAgent(db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Row);
  }

  function authenticate(apiKey: string | undefined): Agent {
    if (!apiKey) throw new PayWingsError('UNAUTHENTICATED', 'Missing agent key (PAYWINGS_AGENT_KEY)');
    const row = db.prepare('SELECT * FROM agents WHERE key_hash = ?').get(sha256(apiKey)) as Row | undefined;
    if (!row) throw new PayWingsError('UNAUTHENTICATED', 'Invalid agent key');
    return rowToAgent(row);
  }

  function paymentById(id: string): Payment | undefined {
    const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToPayment(row) : undefined;
  }

  function expirePending() {
    const at = now().toISOString();
    const stale = db
      .prepare("SELECT id, agent_id FROM payments WHERE status = 'pending_approval' AND expires_at <= ?")
      .all(at) as Row[];
    for (const r of stale) {
      db.prepare("UPDATE payments SET status = 'expired', decided_at = ? WHERE id = ?").run(at, r.id as string);
      audit('system', 'payment.expired', { payment_id: r.id, agent_id: r.agent_id });
    }
  }

  function spendContext(agentId: string, excludeId: string | null) {
    const at = now();
    const monthStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();
    const hourAgo = new Date(at.getTime() - 60 * 60 * 1000).toISOString();
    const committed = db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payments
         WHERE agent_id = ? AND status IN ('executed', 'pending_approval') AND created_at >= ? AND id != ?`,
      )
      .get(agentId, monthStart, excludeId ?? '') as Row;
    const recent = db
      .prepare(
        `SELECT COUNT(*) AS n FROM payments
         WHERE agent_id = ? AND status IN ('executed', 'pending_approval') AND created_at >= ? AND id != ?`,
      )
      .get(agentId, hourAgo, excludeId ?? '') as Row;
    const pending = db
      .prepare("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payments WHERE agent_id = ? AND status = 'pending_approval'")
      .get(agentId) as Row;
    return {
      monthCommittedCents: Number(committed.total),
      txLastHour: Number(recent.n),
      pendingCents: Number(pending.total),
    };
  }

  function resolvePayee(req: PaymentRequest): { payeeId: string | null; merchant: Merchant; errors: Reason[] } {
    if (req.rail === 'card') {
      return {
        payeeId: req.merchantDomain ? normalizePayee(req.merchantDomain) : null,
        merchant: { declaredName: req.merchantName, domain: req.merchantDomain },
        errors: [],
      };
    }
    const merchant: Merchant = { declaredName: req.merchantName };
    if (!req.pixCode) {
      return { payeeId: null, merchant, errors: [{ code: 'PIX_CODE_INVALID', message: 'pix_code is required for Pix payments' }] };
    }
    try {
      const code = parseBrCode(req.pixCode);
      const errors: Reason[] = [];
      if (code.amountCents !== undefined && code.amountCents !== req.amountCents) {
        errors.push({
          code: 'PIX_AMOUNT_MISMATCH',
          message: `Pix code is for ${formatBRL(code.amountCents)}, request is for ${formatBRL(req.amountCents)}`,
        });
      }
      return {
        payeeId: code.pixKey ?? new URL(code.locationUrl!).host,
        merchant: {
          ...merchant,
          pixKey: code.pixKey,
          pixLocation: code.locationUrl,
          pixName: code.merchantName,
          pixCity: code.merchantCity,
        },
        errors,
      };
    } catch (err) {
      if (!(err instanceof BrCodeError)) throw err;
      return { payeeId: null, merchant, errors: [{ code: 'PIX_CODE_INVALID', message: err.message }] };
    }
  }

  function execute(p: Pick<Payment, 'agentId' | 'amountCents' | 'rail' | 'payeeId' | 'merchant'>): Execution {
    const debited = db
      .prepare('UPDATE agents SET balance_cents = balance_cents - ? WHERE id = ? AND balance_cents >= ?')
      .run(p.amountCents, p.agentId, p.amountCents);
    if (debited.changes !== 1) throw new PayWingsError('INSUFFICIENT_FUNDS', 'Wallet balance is too low');
    // Sandbox rails are synchronous. Real issuers/PSPs are network calls and must not run
    // inside this transaction: production uses an "executing" state plus an outbox.
    if (p.rail === 'card') {
      return rails.issueCard({ merchantDomain: p.payeeId!, amountCents: p.amountCents, now: now() });
    }
    return rails.payPix({
      payee: { key: p.merchant.pixKey, location: p.merchant.pixLocation, name: p.merchant.pixName!, city: p.merchant.pixCity! },
      amountCents: p.amountCents,
      now: now(),
    });
  }

  function requestHash(req: PaymentRequest): string {
    return sha256(JSON.stringify([req.amountCents, req.rail, req.merchantDomain ?? null, req.pixCode?.trim() ?? null]));
  }

  return {
    db,

    // ---- Owner credential ----------------------------------------------------
    // The owner key is what separates the human from the agent: the agent's shell can run
    // the CLI and fake a TTY, but it never holds this key. Only its hash is stored.

    hasOwnerKey(): boolean {
      return db.prepare("SELECT 1 FROM settings WHERE key = 'owner_key_hash'").get() !== undefined;
    },

    /** Creates the owner key once. Returns the plaintext key, which is never stored. */
    createOwnerKey(): string {
      const ownerKey = `pw_owner_${randomBytes(24).toString('base64url')}`;
      tx(() => {
        if (db.prepare("SELECT 1 FROM settings WHERE key = 'owner_key_hash'").get()) {
          throw new PayWingsError('OWNER_KEY_EXISTS', 'This sandbox already has an owner key');
        }
        db.prepare("INSERT INTO settings (key, value) VALUES ('owner_key_hash', ?)").run(sha256(ownerKey));
        audit('owner', 'owner.key_created', {});
      });
      return ownerKey;
    },

    /** Throws unless `ownerKey` matches the stored owner key. */
    verifyOwnerKey(ownerKey: string | undefined): void {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'owner_key_hash'").get() as Row | undefined;
      if (!row) {
        throw new PayWingsError('OWNER_KEY_MISSING', 'This sandbox has no owner key yet. Run: paywings owner setup');
      }
      const expected = Buffer.from(row.value as string, 'hex');
      const given = Buffer.from(sha256(ownerKey?.trim() ?? ''), 'hex');
      if (!ownerKey?.trim() || !timingSafeEqual(expected, given)) {
        throw new PayWingsError('OWNER_UNAUTHORIZED', 'Invalid owner key');
      }
    },

    // ---- Owner scope -------------------------------------------------------

    createAgent(name: string, policy: Partial<Policy> = {}, initialBalanceCents = 0) {
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(name)) {
        throw new PayWingsError('INVALID_NAME', 'Agent name must be lowercase letters, digits and dashes');
      }
      const apiKey = `pw_test_${randomBytes(24).toString('base64url')}`;
      const id = `agt_${randomBytes(8).toString('hex')}`;
      const fullPolicy: Policy = { ...DEFAULT_POLICY, ...policy };
      tx(() => {
        if (db.prepare('SELECT 1 FROM agents WHERE name = ?').get(name)) {
          throw new PayWingsError('AGENT_EXISTS', `Agent "${name}" already exists`);
        }
        db.prepare('INSERT INTO agents VALUES (?, ?, ?, ?, ?, ?, ?)').run(
          id,
          name,
          'active',
          sha256(apiKey),
          initialBalanceCents,
          JSON.stringify(fullPolicy),
          now().toISOString(),
        );
        audit('owner', 'agent.created', { agent_id: id, name, policy: fullPolicy, balance_cents: initialBalanceCents });
      });
      return { agent: agentById(id), apiKey };
    },

    listAgents(): Agent[] {
      return (db.prepare('SELECT * FROM agents ORDER BY created_at').all() as Row[]).map(rowToAgent);
    },

    topUp(name: string, amountCents: number): Agent {
      return tx(() => {
        const agent = agentByName(name);
        db.prepare('UPDATE agents SET balance_cents = balance_cents + ? WHERE id = ?').run(amountCents, agent.id);
        audit('owner', 'wallet.topped_up', { agent_id: agent.id, amount_cents: amountCents });
        return agentById(agent.id);
      });
    },

    setStatus(name: string, status: AgentStatus): Agent {
      return tx(() => {
        const agent = agentByName(name);
        db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, agent.id);
        audit('owner', status === 'frozen' ? 'agent.frozen' : 'agent.unfrozen', { agent_id: agent.id });
        return agentById(agent.id);
      });
    },

    updatePolicy(name: string, changes: Partial<Policy>): Agent {
      return tx(() => {
        const agent = agentByName(name);
        const policy = { ...agent.policy, ...changes };
        db.prepare('UPDATE agents SET policy = ? WHERE id = ?').run(JSON.stringify(policy), agent.id);
        audit('owner', 'policy.updated', { agent_id: agent.id, changes });
        return agentById(agent.id);
      });
    },

    listPending(): Array<Payment & { agentName: string }> {
      return tx(() => {
        expirePending();
        return (
          db
            .prepare(
              `SELECT p.*, a.name AS agent_name FROM payments p JOIN agents a ON a.id = p.agent_id
               WHERE p.status = 'pending_approval' ORDER BY p.created_at`,
            )
            .all() as Row[]
        ).map((r) => ({ ...rowToPayment(r), agentName: r.agent_name as string }));
      });
    },

    listPayments(opts: { agentName?: string; limit?: number } = {}): Array<Payment & { agentName: string }> {
      const limit = opts.limit ?? 20;
      const rows = opts.agentName
        ? db
            .prepare(
              `SELECT p.*, a.name AS agent_name FROM payments p JOIN agents a ON a.id = p.agent_id
               WHERE a.name = ? ORDER BY p.created_at DESC LIMIT ?`,
            )
            .all(opts.agentName, limit)
        : db
            .prepare(
              `SELECT p.*, a.name AS agent_name FROM payments p JOIN agents a ON a.id = p.agent_id
               ORDER BY p.created_at DESC LIMIT ?`,
            )
            .all(limit);
      return (rows as Row[]).map((r) => ({ ...rowToPayment(r), agentName: r.agent_name as string }));
    },

    getPaymentAsOwner(id: string): Payment {
      const p = paymentById(id);
      if (!p) throw new PayWingsError('PAYMENT_NOT_FOUND', `Payment ${id} not found`);
      return p;
    },

    approve(paymentId: string): Payment {
      return tx(() => {
        expirePending();
        const p = paymentById(paymentId);
        if (!p) throw new PayWingsError('PAYMENT_NOT_FOUND', `Payment ${paymentId} not found`);
        if (p.status !== 'pending_approval') {
          throw new PayWingsError('INVALID_STATE', `Payment ${paymentId} is ${p.status}, not pending_approval`);
        }
        const agent = agentById(p.agentId);
        // Re-check everything except the approval threshold: balance, status or policy may have changed.
        const decision = evaluate({
          agentActive: agent.status === 'active',
          policy: agent.policy,
          amountCents: p.amountCents,
          rail: p.rail,
          category: p.category,
          payeeId: p.payeeId,
          instrumentErrors: [],
          balanceCents: agent.balanceCents,
          ...spendContext(agent.id, p.id),
          humanApproved: true,
        });
        const at = now().toISOString();
        if (decision.outcome !== 'approved') {
          db.prepare("UPDATE payments SET status = 'denied', reasons = ?, decided_at = ? WHERE id = ?").run(
            JSON.stringify(decision.reasons),
            at,
            p.id,
          );
          audit('owner', 'payment.approval_failed', { payment_id: p.id, reasons: decision.reasons });
          return paymentById(p.id)!;
        }
        const execution = execute(p);
        db.prepare("UPDATE payments SET status = 'executed', reasons = '[]', execution = ?, decided_at = ? WHERE id = ?").run(
          JSON.stringify(execution),
          at,
          p.id,
        );
        audit('owner', 'payment.approved', { payment_id: p.id });
        audit('system', 'payment.executed', { payment_id: p.id, execution: redactExecution(execution) });
        return paymentById(p.id)!;
      });
    },

    reject(paymentId: string, note = ''): Payment {
      return tx(() => {
        expirePending();
        const p = paymentById(paymentId);
        if (!p) throw new PayWingsError('PAYMENT_NOT_FOUND', `Payment ${paymentId} not found`);
        if (p.status !== 'pending_approval') {
          throw new PayWingsError('INVALID_STATE', `Payment ${paymentId} is ${p.status}, not pending_approval`);
        }
        const reasons = note ? [{ code: 'REJECTED_BY_OWNER', message: note }] : [];
        db.prepare("UPDATE payments SET status = 'rejected', reasons = ?, decided_at = ? WHERE id = ?").run(
          JSON.stringify(reasons),
          now().toISOString(),
          p.id,
        );
        audit('owner', 'payment.rejected', { payment_id: p.id, note });
        return paymentById(p.id)!;
      });
    },

    verifyAudit(): { ok: boolean; entries: number; brokenAtSeq?: number } {
      const rows = db.prepare('SELECT seq, body, prev_hash, hash FROM audit ORDER BY seq').all() as Row[];
      let prev = GENESIS;
      for (const r of rows) {
        if (r.prev_hash !== prev || sha256(prev + (r.body as string)) !== r.hash) {
          return { ok: false, entries: rows.length, brokenAtSeq: r.seq as number };
        }
        prev = r.hash as string;
      }
      return { ok: true, entries: rows.length };
    },

    // ---- Agent scope (authenticated by the agent's own key) -----------------

    getWallet(apiKey: string | undefined) {
      const agent = authenticate(apiKey);
      const ctx = spendContext(agent.id, null);
      const p = agent.policy;
      return {
        agent: agent.name,
        status: agent.status,
        balance: formatBRL(agent.balanceCents),
        balance_cents: agent.balanceCents,
        month_committed: formatBRL(ctx.monthCommittedCents),
        month_remaining: formatBRL(Math.max(0, p.monthlyLimitCents - ctx.monthCommittedCents)),
        pending_approval: formatBRL(ctx.pendingCents),
        policy: {
          max_per_transaction: formatBRL(p.maxPerTxCents),
          monthly_limit: formatBRL(p.monthlyLimitCents),
          auto_approve_up_to: formatBRL(p.approvalAboveCents),
          max_payments_per_hour: p.maxTxPerHour,
          allowed_rails: p.allowedRails,
          allowed_merchants: p.allowedMerchants.length ? p.allowedMerchants : 'any',
          blocked_categories: p.blockedCategories,
        },
      };
    },

    requestPayment(apiKey: string | undefined, req: PaymentRequest): Payment & { replayed: boolean } {
      const agent = authenticate(apiKey);
      if (!req.idempotencyKey?.trim()) throw new PayWingsError('IDEMPOTENCY_KEY_REQUIRED', 'idempotency_key is required');
      if (!req.justification?.trim()) throw new PayWingsError('JUSTIFICATION_REQUIRED', 'justification is required');

      return tx(() => {
        expirePending();
        const hash = requestHash(req);
        const existing = db
          .prepare('SELECT * FROM payments WHERE agent_id = ? AND idempotency_key = ?')
          .get(agent.id, req.idempotencyKey) as Row | undefined;
        if (existing) {
          if (existing.request_hash !== hash) {
            throw new PayWingsError('IDEMPOTENCY_CONFLICT', 'idempotency_key was already used with different parameters');
          }
          return { ...rowToPayment(existing), replayed: true };
        }

        const fresh = agentById(agent.id);
        const payee = resolvePayee(req);
        const decision = evaluate({
          agentActive: fresh.status === 'active',
          policy: fresh.policy,
          amountCents: req.amountCents,
          rail: req.rail,
          category: req.category,
          payeeId: payee.payeeId,
          instrumentErrors: payee.errors,
          balanceCents: fresh.balanceCents,
          ...spendContext(fresh.id, null),
        });

        const at = now();
        const id = `pay_${randomBytes(8).toString('hex')}`;
        const status: PaymentStatus =
          decision.outcome === 'approved' ? 'executed' : decision.outcome === 'pending_approval' ? 'pending_approval' : 'denied';
        const expiresAt = status === 'pending_approval' ? new Date(at.getTime() + PENDING_TTL_MS).toISOString() : null;

        const execution =
          status === 'executed'
            ? execute({ agentId: fresh.id, amountCents: req.amountCents, rail: req.rail, payeeId: payee.payeeId, merchant: payee.merchant })
            : null;

        db.prepare(
          `INSERT INTO payments (id, agent_id, idempotency_key, request_hash, amount_cents, rail, payee_id, merchant,
             category, justification, status, reasons, execution, created_at, expires_at, decided_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          fresh.id,
          req.idempotencyKey,
          hash,
          req.amountCents,
          req.rail,
          payee.payeeId,
          JSON.stringify(payee.merchant),
          req.category.toLowerCase(),
          req.justification,
          status,
          JSON.stringify(decision.reasons),
          execution ? JSON.stringify(execution) : null,
          at.toISOString(),
          expiresAt,
          status === 'pending_approval' ? null : at.toISOString(),
        );
        audit(`agent:${fresh.name}`, 'payment.requested', {
          payment_id: id,
          amount_cents: req.amountCents,
          rail: req.rail,
          payee: payee.payeeId,
          merchant: payee.merchant,
          justification: req.justification,
          decision: decision.outcome,
          reasons: decision.reasons,
        });
        if (execution) audit('system', 'payment.executed', { payment_id: id, execution: redactExecution(execution) });
        return { ...paymentById(id)!, replayed: false };
      });
    },

    getPayment(apiKey: string | undefined, paymentId: string): Payment {
      const agent = authenticate(apiKey);
      return tx(() => {
        expirePending();
        const p = paymentById(paymentId);
        if (!p || p.agentId !== agent.id) throw new PayWingsError('PAYMENT_NOT_FOUND', `Payment ${paymentId} not found`);
        return p;
      });
    },

    listMyPayments(apiKey: string | undefined, limit = 10): Payment[] {
      const agent = authenticate(apiKey);
      return (
        db.prepare('SELECT * FROM payments WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?').all(agent.id, limit) as Row[]
      ).map(rowToPayment);
    },

    close() {
      db.close();
    },
  };
}

export type PayWings = ReturnType<typeof createPayWings>;

/** Card details are shown to the owning agent only while the single-use card is still valid. */
export function cardStillValid(p: Payment, at: Date): boolean {
  return p.execution?.type === 'card' && new Date(p.execution.expires_at) > at;
}
