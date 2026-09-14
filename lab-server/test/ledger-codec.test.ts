import { describe, expect, it } from 'vitest';
import { LedgerCodec } from '../src/sails.js';

const IDL = new URL('../../ledger/target/wasm32-gear/release/ledger.idl', import.meta.url).pathname;
const BOB = '0x000000000000000000000000000000000000beef' as const;

describe('LedgerCodec', () => {
  it('encodes Transfer(to, amount) as header + 20-byte address + u64 and decodes a u64 reply', async () => {
    const c = await LedgerCodec.load(IDL);
    const hex = c.encodeTransfer(BOB, 10n);
    expect(hex.slice(0, 10)).toBe('0x474d0110');
    expect((hex.length - 2) / 2).toBe(16 + 20 + 8);
    expect(hex.slice(-56)).toBe('000000000000000000000000000000000000beef' + '0a00000000000000');
    const header = c.encodeBalanceOf(BOB).slice(0, 34);
    expect(c.decodeBalance((header + 'e803000000000000') as `0x${string}`)).toBe(1000n);
    expect((c.encodeFaucet().length - 2) / 2).toBe(16);
  });
});
