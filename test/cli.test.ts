import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const run = (...args: string[]) =>
  execFileSync(process.execPath, ['--no-warnings', 'src/cli.ts', ...args], { encoding: 'utf8' }).trim();

test('--version prints the package version', () => {
  assert.equal(run('--version'), pkg.version);
  assert.equal(run('-v'), pkg.version);
});
