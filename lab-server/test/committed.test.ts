import { describe, expect, it } from 'vitest';
import { CommittedBook } from '../src/committed.js';

const owner = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc' as const;

describe('CommittedBook replay', () => {
  it('replays the program\'s own scenario: ask 5@100, bid 8@101 fills 5 and rests 3, cancel', () => {
    const b = new CommittedBook();
    b.apply({ kind: 'Placed', id: 1n, seq: 1n, owner, side: 1, price: 100n, qty: 5n });
    b.apply({ kind: 'Filled', taker: 2n, maker: 1n, seq: 2n, price: 100n, qty: 5n });
    b.apply({ kind: 'Placed', id: 2n, seq: 3n, owner, side: 0, price: 101n, qty: 3n });
    let v = b.view();
    expect(v.asks).toEqual([]);
    expect(v.bids).toEqual([{ id: 2n, owner, side: 'Bid', price: 101n, qty: 3n }]);
    expect(v.recent_fills).toEqual([{ seq: 2n, taker: 2n, maker: 1n, price: 100n, qty: 5n }]);
    expect(v.seq).toBe(3n);
    expect(v.next_id).toBe(3n);
    b.apply({ kind: 'Cancelled', id: 2n, seq: 4n });
    v = b.view();
    expect(v.bids).toEqual([]);
    expect(v.seq).toBe(4n);
  });

  it('keeps price-time priority and rejects gaps in seq', () => {
    const b = new CommittedBook();
    b.apply({ kind: 'Placed', id: 1n, seq: 1n, owner, side: 1, price: 105n, qty: 1n });
    b.apply({ kind: 'Placed', id: 2n, seq: 2n, owner, side: 1, price: 101n, qty: 1n });
    b.apply({ kind: 'Placed', id: 3n, seq: 3n, owner, side: 1, price: 101n, qty: 1n });
    expect(b.view().asks.map((o) => o.id)).toEqual([2n, 3n, 1n]);
    expect(() => b.apply({ kind: 'Cancelled', id: 1n, seq: 5n })).toThrow(/does not follow/);
  });
});
