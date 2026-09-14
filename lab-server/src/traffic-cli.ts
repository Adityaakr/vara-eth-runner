// Continuous traffic generator (autopilot). Keeps a steady stream of injected transactions flowing
// at a target rate from several accounts and prints one JSON line per completed record, so the
// dashboard is alive without anyone clicking. Runs until killed.
// Usage: tsx src/traffic-cli.ts <rate tx/s> <senders> [burstEverySec=75] [burstSize=250]
// Every `burstEverySec` a burst of `burstSize` transactions is fired at 24 in flight, on top of the
// steady rate, so the chart shows what the validator does under a sudden load.
import { performance } from 'node:perf_hooks';
import { openEngines } from './blast.js';
import { bigintReplacer } from './committed.js';
import { SIDE_ASK, SIDE_BID } from './sails.js';

const rate = Math.max(1, Number(process.argv[2] ?? 20));
const senders = Math.max(1, Number(process.argv[3] ?? 4));
const burstEverySec = Math.max(0, Number(process.argv[4] ?? 90));
const burstSize = Math.max(0, Number(process.argv[5] ?? 120));

async function main() {
  const mirrors = (process.env.LAB_MIRRORS ?? '').split(',').filter(Boolean) as `0x${string}`[];
  const firstSender = Number(process.env.LAB_FIRST_SENDER ?? 9);
  const { engines } = await openEngines(senders, firstSender, mirrors);
  // Realistic-looking flow that cannot fill the book: each instance has a drifting mid price, but a
  // new bid is never below the last ask and a new ask never above the last bid on that instance, so
  // every order crosses the previous opposite one. Only remainders rest, and the next order clears them.
  const mids = engines.map(() => 2_000_000 + Math.floor(Math.random() * 500_000));
  const lastAsk = engines.map((_, i) => mids[i]);
  const lastBid = engines.map((_, i) => mids[i]);
  const nextOrder = (idx: number): { side: number; price: bigint; qty: bigint } => {
    mids[idx] += Math.round((Math.random() - 0.5) * 2);
    const side = nextSide(idx);
    const skew = Math.floor(Math.random() * 3);
    let price: number;
    if (side === SIDE_BID) {
      price = Math.max(mids[idx] + skew, lastAsk[idx]);
      lastBid[idx] = price;
    } else {
      price = Math.min(mids[idx] - skew, lastBid[idx]);
      lastAsk[idx] = price;
    }
    const r = Math.random();
    const qty = BigInt(r < 0.6 ? 1 + Math.floor(Math.random() * 5) : r < 0.9 ? 5 + Math.floor(Math.random() * 20) : 25 + Math.floor(Math.random() * 100));
    return { side, price: BigInt(Math.max(1, price)), qty };
  };
  let i = 0;
  let inFlight = 0;
  // Alternate side per engine (i.e. per program instance), otherwise an instance that only ever
  // receives one side fills its 256-order cap and rejects everything after.
  const sideCounter = engines.map(() => 0);
  const nextSide = (idx: number) => (sideCounter[idx]++ % 2 === 0 ? SIDE_BID : SIDE_ASK);
  const maxInFlight = Math.max(4, Math.ceil(rate / 4));
  let credit = 0;
  let last = performance.now();
  const fire = () => {
    const idx = i % engines.length;
    const engine = engines[idx];
    const { side, price, qty } = nextOrder(idx);
    i++;
    inFlight++;
    engine
      .placeInjected(side, price, qty)
      .then((rec) => console.log(JSON.stringify({ record: rec }, bigintReplacer)))
      .catch((err) => console.error('send failed', err))
      .finally(() => inFlight--);
  };
  // Token bucket: `rate` tokens per second, small jitter so the chart is not a flat line.
  setInterval(() => {
    const now = performance.now();
    credit += ((now - last) / 1000) * rate * (0.85 + Math.random() * 0.3);
    last = now;
    while (credit >= 1 && inFlight < maxInFlight) {
      credit -= 1;
      fire();
    }
    if (credit > rate) credit = rate;
  }, 25);
  if (burstEverySec > 0 && burstSize > 0) {
    setInterval(() => {
      let left = burstSize;
      let burstInFlight = 0;
      const pump = () => {
        while (left > 0 && burstInFlight < 12) {
          left--;
          burstInFlight++;
          const idx = i % engines.length;
          const engine = engines[idx];
          const { side, price, qty } = nextOrder(idx);
          i++;
          engine
            .placeInjected(side, price, qty)
            .then((rec) => console.log(JSON.stringify({ record: rec }, bigintReplacer)))
            .catch((err) => console.error('burst send failed', err))
            .finally(() => {
              burstInFlight--;
              pump();
            });
        }
      };
      console.error(`traffic: burst of ${burstSize}`);
      pump();
    }, burstEverySec * 1000);
  }
  // Housekeeping: each engine cancels a few of ITS OWN oldest resting orders when the instance's book
  // grows past a threshold. Only the owner can cancel, so other processes' orders are left alone, and
  // at most a handful go per tick so cancels stay a small share of the tape.
  const CANCEL_ABOVE = 40;
  const CANCEL_PER_TICK = 3;
  setInterval(() => {
    engines.forEach((engine) => {
      const me = engine.chain.sender.address.toLowerCase();
      engine
        .preconfBook()
        .then(async (view) => {
          const resting = [...view.bids, ...view.asks];
          if (resting.length <= CANCEL_ABOVE) return;
          const mine = resting.filter((o) => o.owner.toLowerCase() === me).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, CANCEL_PER_TICK);
          for (const o of mine) {
            inFlight++;
            const rec = await engine.cancelInjected(o.id).finally(() => inFlight--);
            console.log(JSON.stringify({ record: rec }, bigintReplacer));
          }
        })
        .catch((err) => console.error('cancel sweep failed', err));
    });
  }, 3_000);
  console.error(`traffic: ${rate} tx/s target, ${senders} senders, max in flight ${maxInFlight}, burst ${burstSize} every ${burstEverySec} s`);
}

process.on('SIGTERM', () => process.exit(0));
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
