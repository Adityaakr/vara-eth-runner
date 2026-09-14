import { describe, expect, it } from 'vitest';
import { OrderbookCodec, SIDE_BID } from '../src/sails.js';

const IDL = new URL('../../orderbook/target/wasm32-gear/debug/orderbook.idl', import.meta.url).pathname;

describe('OrderbookCodec', () => {
  it('encodes Place with a Sails v1 header carrying the Book interface id', async () => {
    const codec = await OrderbookCodec.load(IDL);
    const hex = codec.encodePlace(SIDE_BID, 100n, 5n);
    // magic "GM", version 1, header len 16
    expect(hex.slice(0, 10)).toBe('0x474d0110');
    // interface id bytes as sails-idl-meta writes them (header.rs:95, `interface_id.as_bytes()`)
    expect(hex.slice(10, 26)).toBe('92b02ab926ed8b7c');
    // 16-byte header + u32 side + u64 price + u64 qty = 36 bytes
    expect((hex.length - 2) / 2).toBe(36);
    expect(hex.slice(34)).toBe('00000000' + '6400000000000000' + '0500000000000000');
  });

  it('decodes a u64 Place reply and an empty BookView', async () => {
    const codec = await OrderbookCodec.load(IDL);
    const header = codec.encodePlace(SIDE_BID, 1n, 1n).slice(0, 34);
    expect(codec.decodePlaceReply((header + '0700000000000000') as `0x${string}`)).toBe(7n);
    const bookHeader = codec.encodeBookQuery().slice(0, 34);
    const emptyBook = bookHeader + '0000000000000000' + '0100000000000000' + '00' + '00' + '00';
    const view = codec.decodeBookReply(emptyBook as `0x${string}`);
    expect(view).toEqual({ seq: 0n, next_id: 1n, bids: [], asks: [], recent_fills: [] });
  });
});
