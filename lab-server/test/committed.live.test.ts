// Live: committed view lags the pre-confirmed view and converges to it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectChain, type Chain } from '../src/chain.js';
import { quietMirrorAddress } from '../src/config.js';
import { sameBook } from '../src/committed.js';
import { LabEngine } from '../src/engine.js';
import { SIDE_ASK, SIDE_BID } from '../src/sails.js';
import type { WriteRecord } from '../src/timeline.js';

let chain: Chain;
let engine: LabEngine;

beforeAll(async () => {
  chain = await connectChain(1, quietMirrorAddress());
  engine = await LabEngine.create(chain);
  await engine.start();
});
afterAll(async () => {
  engine.stop();
  await chain.disconnect();
});

async function until(pred: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function report(rec: WriteRecord): void {
  const pre = rec.tPreconf !== undefined ? `preconf +${(rec.tPreconf - rec.tSubmit).toFixed(1)}ms` : `mined +${(rec.tL1Mined! - rec.tSubmit).toFixed(1)}ms`;
  console.log(`${rec.path} order ${rec.orderId}: ${pre}, committed +${(rec.tCommitted! - rec.tSubmit).toFixed(0)}ms, blocks ${rec.ethBlock}→${rec.committedBlock}`);
}

describe('committed view', () => {
  it('backfill matches the validator view when idle', async () => {
    const pre = await engine.preconfBook();
    await until(() => engine.committedBook().seq === pre.seq, 15_000);
    expect(sameBook(engine.committedBook(), await engine.preconfBook())).toBe(true);
  });

  it('injected write: preconfirmed first, committed later, then equal', async () => {
    const price = 5_000n + BigInt(Date.now() % 1000);
    const rec = await engine.placeInjected(SIDE_ASK, price, 3n);
    expect(rec.error).toBeUndefined();
    // committed view must NOT contain it at pre-confirmation time
    expect(engine.committedBook().asks.some((o) => o.id === rec.orderId)).toBe(false);
    await until(() => rec.tCommitted !== undefined);
    report(rec);
    expect(rec.tCommitted!).toBeGreaterThan(rec.tPreconf!);
    expect(rec.committedBlock!).toBeGreaterThan(rec.ethBlock!);
    const pre = await engine.preconfBook();
    await until(() => engine.committedBook().seq >= pre.seq);
    expect(sameBook(engine.committedBook(), await engine.preconfBook())).toBe(true);
  });

  it('l1 write: learns its order id from the committed Placed log', async () => {
    const ask = (await engine.preconfBook()).asks[0];
    const rec = await engine.placeL1(SIDE_BID, ask.price, 1n);
    await until(() => rec.tCommitted !== undefined);
    report(rec);
    expect(rec.orderId).toBeDefined();
    expect(rec.tCommitted!).toBeGreaterThan(rec.tL1Mined!);
    const pre = await engine.preconfBook();
    await until(() => engine.committedBook().seq >= pre.seq);
    expect(sameBook(engine.committedBook(), await engine.preconfBook())).toBe(true);
  });
});
