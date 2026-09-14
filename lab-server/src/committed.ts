// The Ethereum-committed view of the book, rebuilt purely from program events that the Router
// has committed to the Mirror contract. No validator data enters here.
import type { Hex } from 'viem';
import type { BookView, FillView, OrderView } from './sails.js';

export type BookEvent =
  | { kind: 'Placed'; id: bigint; seq: bigint; owner: Hex; side: number; price: bigint; qty: bigint }
  | { kind: 'Filled'; taker: bigint; maker: bigint; seq: bigint; price: bigint; qty: bigint }
  | { kind: 'Cancelled'; id: bigint; seq: bigint }
  | { kind: 'Reply'; replyTo: Hex; payload: Hex; replyCode: Hex };

export const MAX_RECENT_FILLS = 64;

export class CommittedBook {
  private seq = 0n;
  private nextId = 1n;
  private bids: OrderView[] = [];
  private asks: OrderView[] = [];
  private fills: FillView[] = [];

  reset(): void {
    this.seq = 0n;
    this.nextId = 1n;
    this.bids = [];
    this.asks = [];
    this.fills = [];
  }

  apply(event: BookEvent): void {
    if (event.kind === 'Reply') return; // not a book state change
    if (event.seq !== this.seq + 1n) {
      throw new Error(`event seq ${event.seq} does not follow ${this.seq}`);
    }
    this.seq = event.seq;
    switch (event.kind) {
      case 'Placed': {
        if (event.id >= this.nextId) this.nextId = event.id + 1n;
        if (event.qty > 0n) {
          const side = event.side === 0 ? 'Bid' : 'Ask';
          insertSorted(side === 'Bid' ? this.bids : this.asks, {
            id: event.id,
            owner: event.owner,
            side,
            price: event.price,
            qty: event.qty,
          });
        }
        break;
      }
      case 'Filled': {
        const maker = this.bids.find((o) => o.id === event.maker) ?? this.asks.find((o) => o.id === event.maker);
        if (!maker) throw new Error(`fill against unknown maker ${event.maker}`);
        maker.qty -= event.qty;
        if (maker.qty === 0n) this.remove(maker.id);
        if (this.fills.length === MAX_RECENT_FILLS) this.fills.shift();
        this.fills.push({ seq: event.seq, taker: event.taker, maker: event.maker, price: event.price, qty: event.qty });
        break;
      }
      case 'Cancelled':
        this.remove(event.id);
        break;
    }
  }

  view(): BookView {
    return {
      seq: this.seq,
      next_id: this.nextId,
      bids: this.bids.map((o) => ({ ...o })),
      asks: this.asks.map((o) => ({ ...o })),
      recent_fills: this.fills.map((f) => ({ ...f })),
    };
  }

  private remove(id: bigint): void {
    this.bids = this.bids.filter((o) => o.id !== id);
    this.asks = this.asks.filter((o) => o.id !== id);
  }
}

/** Same ordering as the program: bids price desc, asks price asc, ties by id asc. */
function ranksBefore(a: OrderView, b: OrderView): boolean {
  if (a.price !== b.price) return a.side === 'Bid' ? a.price > b.price : a.price < b.price;
  return a.id < b.id;
}

function insertSorted(book: OrderView[], order: OrderView): void {
  let pos = 0;
  while (pos < book.length && ranksBefore(book[pos], order)) pos++;
  book.splice(pos, 0, order);
}

/** Structural equality of two views, ignoring nothing: this is the lab's divergence check. */
export function sameBook(a: BookView, b: BookView): boolean {
  return JSON.stringify(a, bigintReplacer) === JSON.stringify(b, bigintReplacer);
}

export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
