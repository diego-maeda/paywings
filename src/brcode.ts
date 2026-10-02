/**
 * Pix BR Code ("copia e cola") parsing and building, per the BCB EMV-MPM profile.
 * Each field is ID (2 digits) + length (2 digits) + value; field 63 holds a CRC16-CCITT
 * checksum computed over the whole payload up to and including "6304".
 */

export class BrCodeError extends Error {}

export type BrCode = {
  pixKey?: string;
  /** Dynamic codes carry a PSP location URL instead of a key. */
  locationUrl?: string;
  merchantName: string;
  merchantCity: string;
  amountCents?: number;
  txid?: string;
};

const PIX_GUI = 'br.gov.bcb.pix';

export function crc16(payload: string): string {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(payload)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function parseTlv(data: string): Map<string, string> {
  const fields = new Map<string, string>();
  let i = 0;
  while (i < data.length) {
    const id = data.slice(i, i + 2);
    const len = Number(data.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(id) || !Number.isInteger(len) || i + 4 + len > data.length) {
      throw new BrCodeError(`Malformed field at position ${i}`);
    }
    fields.set(id, data.slice(i + 4, i + 4 + len));
    i += 4 + len;
  }
  return fields;
}

export function parseBrCode(raw: string): BrCode {
  const code = raw.trim();
  if (code.length < 30 || !code.startsWith('000201')) {
    throw new BrCodeError('Not a BR Code: must start with payload format indicator 000201');
  }
  const crcStart = code.length - 8;
  if (code.slice(crcStart, crcStart + 4) !== '6304') {
    throw new BrCodeError('Missing CRC field (63)');
  }
  const expected = crc16(code.slice(0, crcStart + 4));
  if (code.slice(crcStart + 4).toUpperCase() !== expected) {
    throw new BrCodeError('CRC mismatch: code is corrupted or was altered');
  }

  const fields = parseTlv(code);
  const account = fields.get('26');
  if (!account) throw new BrCodeError('Missing merchant account information (26)');
  const accountFields = parseTlv(account);
  if (accountFields.get('00')?.toLowerCase() !== PIX_GUI) {
    throw new BrCodeError('Merchant account is not a Pix arrangement');
  }
  const pixKey = accountFields.get('01');
  const location = accountFields.get('25');
  if (!pixKey && !location) throw new BrCodeError('Code has neither a Pix key nor a location URL');
  if (fields.get('53') !== '986') throw new BrCodeError('Currency must be BRL (986)');

  const merchantName = fields.get('59');
  const merchantCity = fields.get('60');
  if (!merchantName || !merchantCity) throw new BrCodeError('Missing merchant name (59) or city (60)');

  let amountCents: number | undefined;
  const amount = fields.get('54');
  if (amount !== undefined) {
    if (!/^\d+(\.\d{1,2})?$/.test(amount)) throw new BrCodeError(`Invalid amount "${amount}"`);
    amountCents = Math.round(Number(amount) * 100);
  }

  const additional = fields.get('62');
  const txid = additional ? parseTlv(additional).get('05') : undefined;

  return {
    pixKey,
    locationUrl: location ? `https://${location.replace(/^https?:\/\//, '')}` : undefined,
    merchantName,
    merchantCity,
    amountCents,
    txid,
  };
}

function tlv(id: string, value: string): string {
  return id + String(value.length).padStart(2, '0') + value;
}

/** Builds a static BR Code. Used by the sandbox CLI and tests to produce valid codes. */
export function buildBrCode(input: {
  pixKey: string;
  merchantName: string;
  merchantCity: string;
  amountCents?: number;
  txid?: string;
}): string {
  const amount =
    input.amountCents === undefined
      ? ''
      : tlv('54', `${Math.floor(input.amountCents / 100)}.${String(input.amountCents % 100).padStart(2, '0')}`);
  const payload =
    tlv('00', '01') +
    tlv('26', tlv('00', PIX_GUI) + tlv('01', input.pixKey)) +
    tlv('52', '0000') +
    tlv('53', '986') +
    amount +
    tlv('58', 'BR') +
    tlv('59', input.merchantName.slice(0, 25)) +
    tlv('60', input.merchantCity.slice(0, 15)) +
    tlv('62', tlv('05', input.txid ?? '***')) +
    '6304';
  return payload + crc16(payload);
}
