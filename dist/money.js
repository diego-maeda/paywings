export class AmountError extends Error {
}
/** Converts a reais amount (number, or "20", "20.5", "20,50") into integer cents. */
export function toCents(input) {
    let reais;
    if (typeof input === 'number') {
        reais = input;
    }
    else {
        const normalized = input.trim().replace(',', '.');
        if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
            throw new AmountError(`Invalid amount "${input}": use digits with up to 2 decimals, e.g. 20,50`);
        }
        reais = Number(normalized);
    }
    if (!Number.isFinite(reais) || reais <= 0) {
        throw new AmountError('Amount must be a positive number');
    }
    const cents = Math.round(reais * 100);
    if (Math.abs(reais * 100 - cents) > 1e-6) {
        throw new AmountError('Amount must have at most 2 decimal places');
    }
    return cents;
}
export function formatBRL(cents) {
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(cents);
    const reais = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return `${sign}R$ ${reais},${String(abs % 100).padStart(2, '0')}`;
}
