// Live test against the running local stack (run/start-node.sh + run/deploy.sh).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectChain, type Chain } from '../src/chain.js';
import { LabEngine } from '../src/engine.js';
import { SIDE_ASK, SIDE_BID } from '../src/sails.js';

let chain: Chain;
let engine: LabEngine;

beforeAll(async () => {
  chain = await connectChain(0);
  engine = await LabEngine.create(chain);
});
afterAll(async () => {
  await chain.disconnect();
});

async function waitForSeq(target: bigint, timeoutMs = 15_000): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  let seq = await engine.preconfSeq();
  while (seq < target && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    seq = await engine.preconfSeq();
  }
  return seq;
}

describe('LabEngine against the live stack', () => {
  it('injected place returns a promise and shows up in the pre-confirmed book', async () => {
    const seq0 = await engine.preconfSeq();
    const price = 1_000n + BigInt(Date.now() % 1000); // unique price so the test is rerunnable
    const rec = await engine.placeInjected(SIDE_ASK, price, 5n);
    expect(rec.error).toBeUndefined();
    expect(rec.orderId).toBeGreaterThan(0n);
    expect(rec.validator).toBeDefined();
    const preconfMs = rec.tPreconf! - rec.tSubmit;
    console.log(`injected: submit→promise ${preconfMs.toFixed(1)} ms, order ${rec.orderId}`);
    expect(preconfMs).toBeLessThan(5_000);
    const seq = await waitForSeq(seq0 + 1n);
    expect(seq).toBe(seq0 + 1n);
    const book = await engine.preconfBook();
    expect(book.asks.some((o) => o.id === rec.orderId && o.price === price && o.qty === 5n)).toBe(true);
  });

  it('L1 place is mined on Anvil and then executed by the validator, crossing the resting ask', async () => {
    const before = await engine.preconfBook();
    const ask = before.asks[0];
    expect(ask).toBeDefined();
    const rec = await engine.placeL1(SIDE_BID, ask.price, 2n);
    expect(rec.tL1Mined).toBeDefined();
    expect(rec.messageId).toBeDefined();
    console.log(`l1: submit→mined ${(rec.tL1Mined! - rec.tSubmit).toFixed(1)} ms, block ${rec.ethBlock}`);
    // one Filled + one Placed event => seq + 2
    const seq = await waitForSeq(before.seq + 2n);
    expect(seq).toBe(before.seq + 2n);
    const after = await engine.preconfBook();
    const fill = after.recent_fills[after.recent_fills.length - 1];
    expect(fill.maker).toBe(ask.id);
    expect(fill.qty).toBe(2n);
    expect(fill.price).toBe(ask.price);
  });
});
