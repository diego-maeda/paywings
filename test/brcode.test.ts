import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrCode, crc16, parseBrCode, BrCodeError } from '../src/brcode.ts';
import { AmountError, formatBRL, toCents } from '../src/money.ts';

test('parses the BCB reference BR Code', () => {
  const code =
    '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D';
  const parsed = parseBrCode(code);
  assert.equal(parsed.pixKey, '123e4567-e12b-12d1-a456-426655440000');
  assert.equal(parsed.merchantName, 'Fulano de Tal');
  assert.equal(parsed.merchantCity, 'BRASILIA');
  assert.equal(parsed.amountCents, undefined);
});

test('round-trips a built code with amount and txid', () => {
  const code = buildBrCode({ pixKey: 'loja@exemplo.com', merchantName: 'Loja Exemplo', merchantCity: 'Sao Paulo', amountCents: 3590, txid: 'PED123' });
  assert.deepEqual(parseBrCode(code), {
    pixKey: 'loja@exemplo.com',
    locationUrl: undefined,
    merchantName: 'Loja Exemplo',
    merchantCity: 'Sao Paulo',
    amountCents: 3590,
    txid: 'PED123',
  });
});

test('rejects a code whose payee key was swapped without fixing the CRC', () => {
  const code = buildBrCode({ pixKey: 'loja@exemplo.com', merchantName: 'Loja', merchantCity: 'Sao Paulo' });
  const tampered = code.replace('loja@exemplo.com', 'golp@exemplo.com');
  assert.throws(() => parseBrCode(tampered), /CRC mismatch/);
});

test('rejects garbage', () => {
  assert.throws(() => parseBrCode('hello'), BrCodeError);
});

test('crc16 matches the CCITT-FALSE check value', () => {
  assert.equal(crc16('123456789'), '29B1');
});

test('toCents accepts comma and dot decimals', () => {
  assert.equal(toCents('20,50'), 2050);
  assert.equal(toCents('20.5'), 2050);
  assert.equal(toCents(49.9), 4990);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.throws(() => toCents('1.234,56'), AmountError);
  assert.throws(() => toCents(1.234), AmountError);
  assert.throws(() => toCents(-5), AmountError);
});

test('formatBRL', () => {
  assert.equal(formatBRL(123456), 'R$ 1.234,56');
  assert.equal(formatBRL(5), 'R$ 0,05');
});
