// Sails IDL v2 codec for the orderbook program: encodes command/query payloads (16-byte Sails
// header + SCALE args) and decodes replies. Pure, no chain connection needed.
import { readFileSync } from 'node:fs';
import { SailsProgram } from 'sails-js';
import { SailsIdlParser } from 'sails-js/parser';
import type { Hex } from 'viem';

export type BookView = {
  seq: bigint;
  next_id: bigint;
  bids: OrderView[];
  asks: OrderView[];
  recent_fills: FillView[];
};
export type OrderView = { id: bigint; owner: Hex; side: 'Bid' | 'Ask'; price: bigint; qty: bigint };
export type FillView = { seq: bigint; taker: bigint; maker: bigint; price: bigint; qty: bigint };

export const SIDE_BID = 0;
export const SIDE_ASK = 1;

export class OrderbookCodec {
  private constructor(private readonly program: SailsProgram) {}

  static async load(idlPath: string): Promise<OrderbookCodec> {
    const parser = new SailsIdlParser();
    await parser.init();
    const doc = parser.parse(readFileSync(idlPath, 'utf8'));
    return new OrderbookCodec(new SailsProgram(doc));
  }

  private get book() {
    return this.program.services.Book;
  }

  encodePlace(side: number, price: bigint, qty: bigint): Hex {
    return this.book.functions.Place.encodePayload(side, price, qty) as Hex;
  }

  encodeCancel(id: bigint): Hex {
    return this.book.functions.Cancel.encodePayload(id) as Hex;
  }

  encodeBookQuery(): Hex {
    return this.book.queries.Book.encodePayload() as Hex;
  }

  encodeSeqQuery(): Hex {
    return this.book.queries.Seq.encodePayload() as Hex;
  }

  decodePlaceReply(payload: Hex): bigint {
    return toBigInt(this.book.functions.Place.decodeResult(payload));
  }

  decodeBookReply(payload: Hex): BookView {
    const raw = this.book.queries.Book.decodeResult(payload) as Record<string, unknown>;
    const order = (o: Record<string, unknown>): OrderView => ({
      id: toBigInt(o.id),
      owner: String(o.owner).toLowerCase() as Hex,
      side: o.side as 'Bid' | 'Ask',
      price: toBigInt(o.price),
      qty: toBigInt(o.qty),
    });
    const fill = (f: Record<string, unknown>): FillView => ({
      seq: toBigInt(f.seq),
      taker: toBigInt(f.taker),
      maker: toBigInt(f.maker),
      price: toBigInt(f.price),
      qty: toBigInt(f.qty),
    });
    return {
      seq: toBigInt(raw.seq),
      next_id: toBigInt(raw.next_id),
      bids: (raw.bids as Record<string, unknown>[]).map(order),
      asks: (raw.asks as Record<string, unknown>[]).map(order),
      recent_fills: (raw.recent_fills as Record<string, unknown>[]).map(fill),
    };
  }

  decodeSeqReply(payload: Hex): bigint {
    return toBigInt(this.book.queries.Seq.decodeResult(payload));
  }
}

// sails-js returns numbers for small values and strings/bigints for large ones.
function toBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string') return BigInt(v.replace(/,/g, ''));
  throw new Error(`cannot convert ${String(v)} to bigint`);
}

/** Codec for the wallet's ledger program: transfer, faucet, balance query. */
export class LedgerCodec {
  private constructor(private readonly program: SailsProgram) {}

  static async load(idlPath: string): Promise<LedgerCodec> {
    const parser = new SailsIdlParser();
    await parser.init();
    return new LedgerCodec(new SailsProgram(parser.parse(readFileSync(idlPath, 'utf8'))));
  }

  private get svc() {
    return this.program.services.Ledger;
  }

  encodeTransfer(to: Hex, amount: bigint): Hex {
    return this.svc.functions.Transfer.encodePayload(to, amount) as Hex;
  }

  encodeFaucet(): Hex {
    return this.svc.functions.Faucet.encodePayload() as Hex;
  }

  encodeBalanceOf(who: Hex): Hex {
    return this.svc.queries.BalanceOf.encodePayload(who) as Hex;
  }

  // sails-js checks the reply header against the export it decodes for, so each reply has its own decoder.
  decodeBalance(payload: Hex): bigint {
    return toBigInt(this.svc.queries.BalanceOf.decodeResult(payload));
  }

  decodeTransferReply(payload: Hex): bigint {
    return toBigInt(this.svc.functions.Transfer.decodeResult(payload));
  }

  decodeFaucetReply(payload: Hex): bigint {
    return toBigInt(this.svc.functions.Faucet.decodeResult(payload));
  }
}
