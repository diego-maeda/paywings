import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildBrCode } from './brcode.js';
import { createMcpServer } from './mcp.js';
import { AmountError, formatBRL, toCents } from './money.js';
import { cardStillValid, createPayWings, PayWingsError, toView } from './service.js';
const HELP = `paywings — sandbox de pagamentos com políticas para agentes de IA

Dono (humano):
  init                                  Cria o sandbox com o agente "demo" (saldo R$ 500,00)
  agents list
  agents create <nome> [limites]        Imprime a chave do agente (mostrada uma única vez)
  agents policy <nome> [limites]        Altera limites de um agente
  agents freeze|unfreeze <nome>         Kill switch
  topup <nome> <valor>
  pending                               Pagamentos aguardando aprovação
  approve <id>                          Exige terminal interativo
  reject <id> [--note texto]
  payments [--agent nome] [--limit n]
  audit verify | audit log [--limit n]

Agente (autenticado por PAYWINGS_AGENT_KEY):
  pay --amount 49,90 --rail card --merchant "Vercel" --domain vercel.com --category software --reason "..."
  pay --amount 35,90 --rail pix --merchant "Padaria" --pix "<copia e cola>" --category food --reason "..."
  status <id>
  mcp                                   Sobe o servidor MCP (stdio)

Utilitários:
  pix-code --key <chave> --name <nome> --city <cidade> [--amount 35,90]

Limites: --balance --per-tx --monthly --approve-above --per-hour --merchants a.com,b.com --rails card,pix --block gambling,crypto
Banco: PAYWINGS_DB (padrão ~/.paywings/sandbox.db)`;
const { values: flags, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        amount: { type: 'string' },
        rail: { type: 'string' },
        merchant: { type: 'string' },
        domain: { type: 'string' },
        pix: { type: 'string' },
        category: { type: 'string' },
        reason: { type: 'string' },
        'idempotency-key': { type: 'string' },
        agent: { type: 'string' },
        limit: { type: 'string' },
        note: { type: 'string' },
        balance: { type: 'string' },
        'per-tx': { type: 'string' },
        monthly: { type: 'string' },
        'approve-above': { type: 'string' },
        'per-hour': { type: 'string' },
        merchants: { type: 'string' },
        rails: { type: 'string' },
        block: { type: 'string' },
        key: { type: 'string' },
        name: { type: 'string' },
        city: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
    },
});
const dbPath = process.env.PAYWINGS_DB ?? join(homedir(), '.paywings', 'sandbox.db');
function open() {
    mkdirSync(dirname(dbPath), { recursive: true });
    return createPayWings({ path: dbPath });
}
function list(value) {
    return value ? value.split(',').map((s) => s.trim()).filter(Boolean) : [];
}
function policyFromFlags() {
    const p = {};
    if (flags['per-tx'])
        p.maxPerTxCents = toCents(flags['per-tx']);
    if (flags.monthly)
        p.monthlyLimitCents = toCents(flags.monthly);
    if (flags['approve-above'])
        p.approvalAboveCents = toCents(flags['approve-above']);
    if (flags['per-hour'])
        p.maxTxPerHour = Number(flags['per-hour']);
    if (flags.merchants !== undefined)
        p.allowedMerchants = list(flags.merchants);
    if (flags.rails)
        p.allowedRails = list(flags.rails);
    if (flags.block !== undefined)
        p.blockedCategories = list(flags.block);
    return p;
}
function require(value, name) {
    if (!value)
        throw new PayWingsError('MISSING_ARGUMENT', `Missing ${name}`);
    return value;
}
function printPaymentLine(p) {
    const who = p.agentName ? `${p.agentName.padEnd(14)} ` : '';
    const payee = p.merchant.pixName ? `${p.merchant.pixName} (${p.payeeId})` : (p.payeeId ?? p.merchant.declaredName);
    console.log(`${p.id}  ${who}${p.status.padEnd(16)} ${formatBRL(p.amountCents).padStart(12)}  ${p.rail.padEnd(4)}  ${payee}`);
}
function printSetup(name, apiKey) {
    console.log(`\nChave do agente "${name}" (guarde agora, não será mostrada de novo):\n  ${apiKey}\n`);
    console.log('Para usar no terminal:');
    console.log(`  export PAYWINGS_AGENT_KEY=${apiKey}\n`);
    console.log('Para registrar no Claude Code:');
    console.log(`  claude mcp add paywings --env PAYWINGS_AGENT_KEY=${apiKey} --env PAYWINGS_DB=${dbPath} -- paywings mcp\n`);
}
async function confirmApproval(p) {
    // Agents run shell commands without a TTY; requiring one keeps them from approving their own payments.
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new PayWingsError('TTY_REQUIRED', 'approve must be run by a human in an interactive terminal');
    }
    console.log('\nPagamento aguardando aprovação:');
    console.log(`  Agente:        ${p.agentName}`);
    console.log(`  Valor:         ${formatBRL(p.amountCents)} via ${p.rail}`);
    console.log(`  Recebedor:     ${p.payeeId}${p.merchant.pixName ? ` — ${p.merchant.pixName}, ${p.merchant.pixCity}` : ''}`);
    console.log(`  Agente disse:  ${p.merchant.declaredName} / ${p.category}`);
    console.log(`  Justificativa: ${p.justification}\n`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const typed = await rl.question(`Digite o valor (${formatBRL(p.amountCents).replace('R$ ', '')}) para aprovar: `);
    rl.close();
    try {
        return toCents(typed) === p.amountCents;
    }
    catch {
        return false;
    }
}
async function main() {
    const [cmd, sub, arg] = positionals;
    if (!cmd || flags.help) {
        console.log(HELP);
        return;
    }
    if (cmd === 'pix-code') {
        console.log(buildBrCode({
            pixKey: require(flags.key, '--key'),
            merchantName: require(flags.name, '--name'),
            merchantCity: require(flags.city, '--city'),
            amountCents: flags.amount ? toCents(flags.amount) : undefined,
        }));
        return;
    }
    const m = open();
    const agentKey = process.env.PAYWINGS_AGENT_KEY;
    switch (cmd) {
        case 'init': {
            if (m.listAgents().length > 0)
                throw new PayWingsError('ALREADY_INITIALIZED', `Sandbox already exists at ${dbPath}`);
            const { apiKey } = m.createAgent('demo', {}, 500_00);
            console.log(`Sandbox criado em ${dbPath} com o agente "demo" e saldo de R$ 500,00.`);
            console.log('Política padrão: até R$ 200,00 por compra, R$ 1.000,00 por mês, aprovação humana acima de R$ 50,00.');
            printSetup('demo', apiKey);
            return;
        }
        case 'agents': {
            if (sub === 'list' || !sub) {
                for (const a of m.listAgents()) {
                    const p = a.policy;
                    console.log(`${a.name.padEnd(16)} ${a.status.padEnd(7)} saldo ${formatBRL(a.balanceCents).padStart(12)}  ` +
                        `por compra ${formatBRL(p.maxPerTxCents)}  mês ${formatBRL(p.monthlyLimitCents)}  ` +
                        `aprovação > ${formatBRL(p.approvalAboveCents)}  lojistas: ${p.allowedMerchants.join(', ') || 'qualquer'}`);
                }
                return;
            }
            const name = require(arg, '<nome>');
            if (sub === 'create') {
                const { apiKey } = m.createAgent(name, policyFromFlags(), flags.balance ? toCents(flags.balance) : 0);
                console.log(`Agente "${name}" criado.`);
                printSetup(name, apiKey);
            }
            else if (sub === 'policy') {
                const a = m.updatePolicy(name, policyFromFlags());
                console.log(JSON.stringify(a.policy, null, 2));
            }
            else if (sub === 'freeze' || sub === 'unfreeze') {
                m.setStatus(name, sub === 'freeze' ? 'frozen' : 'active');
                console.log(`Agente "${name}" ${sub === 'freeze' ? 'congelado' : 'reativado'}.`);
            }
            else {
                throw new PayWingsError('UNKNOWN_COMMAND', `Unknown: agents ${sub}`);
            }
            return;
        }
        case 'topup': {
            const a = m.topUp(require(sub, '<nome>'), toCents(require(arg, '<valor>')));
            console.log(`Novo saldo de ${a.name}: ${formatBRL(a.balanceCents)}`);
            return;
        }
        case 'pay': {
            const idempotencyKey = flags['idempotency-key'] ?? randomUUID();
            const payment = m.requestPayment(agentKey, {
                amountCents: toCents(require(flags.amount, '--amount')),
                rail: require(flags.rail, '--rail'),
                merchantName: require(flags.merchant, '--merchant'),
                merchantDomain: flags.domain,
                pixCode: flags.pix,
                category: require(flags.category, '--category'),
                justification: require(flags.reason, '--reason'),
                idempotencyKey,
            });
            console.log(JSON.stringify({ ...toView(payment, { revealCard: cardStillValid(payment, new Date()) }), idempotency_key: idempotencyKey, replayed: payment.replayed }, null, 2));
            return;
        }
        case 'status': {
            const payment = m.getPayment(agentKey, require(sub, '<id>'));
            console.log(JSON.stringify(toView(payment, { revealCard: cardStillValid(payment, new Date()) }), null, 2));
            return;
        }
        case 'pending': {
            const pending = m.listPending();
            if (pending.length === 0)
                console.log('Nenhum pagamento aguardando aprovação.');
            for (const p of pending) {
                printPaymentLine(p);
                console.log(`    ${p.justification}`);
            }
            return;
        }
        case 'approve': {
            const id = require(sub, '<id>');
            const p = m.listPending().find((x) => x.id === id);
            if (!p)
                throw new PayWingsError('PAYMENT_NOT_FOUND', `${id} is not pending approval`);
            if (!(await confirmApproval(p))) {
                console.log('Valor não confere. Nada foi aprovado.');
                process.exitCode = 1;
                return;
            }
            const result = m.approve(id);
            console.log(result.status === 'executed' ? `Aprovado e executado: ${id}` : `Não executado: ${JSON.stringify(result.reasons)}`);
            return;
        }
        case 'reject': {
            m.reject(require(sub, '<id>'), flags.note ?? '');
            console.log(`Rejeitado: ${sub}`);
            return;
        }
        case 'payments': {
            for (const p of m.listPayments({ agentName: flags.agent, limit: flags.limit ? Number(flags.limit) : 20 })) {
                printPaymentLine(p);
            }
            return;
        }
        case 'audit': {
            if (sub === 'verify') {
                const r = m.verifyAudit();
                console.log(r.ok ? `Cadeia íntegra: ${r.entries} registros.` : `ADULTERADA no registro #${r.brokenAtSeq}.`);
                if (!r.ok)
                    process.exitCode = 2;
            }
            else {
                const rows = m.db.prepare('SELECT seq, body FROM audit ORDER BY seq DESC LIMIT ?').all(Number(flags.limit ?? 20));
                for (const r of rows)
                    console.log(`#${r.seq} ${r.body}`);
            }
            return;
        }
        case 'mcp': {
            // Fail fast on a bad key instead of failing on the first tool call.
            m.getWallet(agentKey);
            await createMcpServer(m, agentKey).connect(new StdioServerTransport());
            return;
        }
        default:
            throw new PayWingsError('UNKNOWN_COMMAND', `Unknown command "${cmd}". Run paywings --help`);
    }
}
main().catch((err) => {
    if (err instanceof PayWingsError || err instanceof AmountError) {
        console.error(`erro: ${err.message}`);
        process.exit(1);
    }
    throw err;
});
