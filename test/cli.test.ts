import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

type Run = { code: number | null; out: string; err: string };

/** Runs the CLI the way an agent's shell would: no TTY, stdin piped (empty unless `input` is given). */
function cli(db: string, args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Run {
  const r = spawnSync(process.execPath, ['--no-warnings', CLI, ...args], {
    input: opts.input ?? '',
    encoding: 'utf8',
    env: { ...process.env, PAYWINGS_DB: db, PAYWINGS_AGENT_KEY: '', ...opts.env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function sandbox() {
  const db = join(mkdtempSync(join(tmpdir(), 'paywings-cli-')), 'sandbox.db');
  const init = cli(db, ['init']);
  assert.equal(init.code, 0, init.err);
  const ownerKey = init.out.match(/pw_owner_[\w-]+/)?.[0];
  const agentKey = init.out.match(/pw_test_[\w-]+/)?.[0];
  assert.ok(ownerKey && agentKey, 'init prints both keys');
  return { db, ownerKey, agentKey };
}

const pay = (amount: string, id: string) => [
  'pay', '--amount', amount, '--rail', 'card', '--merchant', 'X', '--domain', 'x.io',
  '--category', 'software', '--reason', 'teste automatizado', '--idempotency-key', id,
];

test('an agent with only its own key cannot raise its limits or top up', () => {
  const { db, agentKey } = sandbox();
  const env = { PAYWINGS_AGENT_KEY: agentKey };
  for (const args of [
    ['agents', 'policy', 'demo', '--per-tx', '99999', '--approve-above', '99999'],
    ['topup', 'demo', '50000'],
    ['agents', 'create', 'evil', '--balance', '1000'],
    ['agents', 'unfreeze', 'demo'],
    ['reject', 'pay_x'],
  ]) {
    const r = cli(db, args, { env });
    assert.equal(r.code, 1, `${args.join(' ')} should fail`);
    assert.match(r.err, /owner key|pay_x/i);
  }
  // The attack from the gap analysis: R$ 900 to an unknown domain must not execute.
  const r = cli(db, pay('900', 'attack-1'), { env });
  assert.equal(JSON.parse(r.out).status, 'denied');
});

test('a wrong owner key is refused', () => {
  const { db } = sandbox();
  const r = cli(db, ['topup', 'demo', '10'], { input: 'pw_owner_guess\n' });
  assert.equal(r.code, 1);
  assert.match(r.err, /Invalid owner key/);
});

test('the owner key piped on stdin authorizes owner commands', () => {
  const { db, ownerKey } = sandbox();
  const r = cli(db, ['topup', 'demo', '10'], { input: `${ownerKey}\n` });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /R\$ 510,00/);
  const policy = cli(db, ['agents', 'policy', 'demo', '--per-tx', '300'], { input: `${ownerKey}\n` });
  assert.equal(policy.code, 0, policy.err);
  assert.equal(JSON.parse(policy.out.slice(policy.out.indexOf('{'))).maxPerTxCents, 300_00);
});

test('freeze needs no key, unfreeze does', () => {
  const { db, ownerKey, agentKey } = sandbox();
  assert.equal(cli(db, ['agents', 'freeze', 'demo']).code, 0);
  assert.equal(JSON.parse(cli(db, pay('10', 'frozen-1'), { env: { PAYWINGS_AGENT_KEY: agentKey } }).out).status, 'denied');
  assert.equal(cli(db, ['agents', 'unfreeze', 'demo']).code, 1);
  assert.equal(cli(db, ['agents', 'unfreeze', 'demo'], { input: `${ownerKey}\n` }).code, 0);
});

test('approve still requires an interactive terminal', () => {
  const { db, ownerKey, agentKey } = sandbox();
  const pending = JSON.parse(cli(db, pay('60', 'pending-1'), { env: { PAYWINGS_AGENT_KEY: agentKey } }).out);
  assert.equal(pending.status, 'pending_approval');
  const r = cli(db, ['approve', pending.id], { input: `${ownerKey}\n60,00\n` });
  assert.equal(r.code, 1);
  assert.match(r.err, /interactive terminal/);
});

test('owner setup only works once', () => {
  const { db } = sandbox();
  const r = cli(db, ['owner', 'setup']);
  assert.equal(r.code, 1);
  assert.match(r.err, /already has an owner key/);
});

test('two processes racing for the last of the balance never overspend', async () => {
  const { db, ownerKey, agentKey } = sandbox();
  // Leave R$ 30: each process asks for R$ 20, so at most one can succeed.
  assert.equal(cli(db, ['agents', 'policy', 'demo', '--approve-above', '200'], { input: `${ownerKey}\n` }).code, 0);
  for (const [i, amount] of ['200', '200', '70'].entries()) {
    assert.equal(JSON.parse(cli(db, pay(amount, `drain-${i}`), { env: { PAYWINGS_AGENT_KEY: agentKey } }).out).status, 'executed');
  }
  const run = (id: string) =>
    new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ['--no-warnings', CLI, ...pay('20', id)], {
        env: { ...process.env, PAYWINGS_DB: db, PAYWINGS_AGENT_KEY: agentKey },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('close', () => resolve(JSON.parse(out).status));
    });
  const statuses = await Promise.all([run('race-a'), run('race-b')]);
  assert.deepEqual(statuses.sort(), ['denied', 'executed']);
});
