// Load generator: fire many injected transactions concurrently from several senders and record
// each one's submit → pre-confirmation latency, so throughput and latency are measured, not quoted.
import { performance } from 'node:perf_hooks';
import { connectChain, type Chain } from './chain.js';
import { LabEngine } from './engine.js';
import { SIDE_ASK, SIDE_BID } from './sails.js';
import type { WriteRecord } from './timeline.js';

export interface BlastOptions {
  /** Total injected transactions to send. */
  total: number;
  /** In-flight transactions at once. */
  concurrency: number;
  /** Number of distinct sender accounts to rotate through (each needs its own engine/connection). */
  senders: number;
}

export interface BlastResult {
  readonly total: number;
  readonly concurrency: number;
  readonly senders: number;
  readonly wallMs: number;
  /** Pre-confirmations completed per second over the whole run. */
  readonly preconfPerSec: number;
  readonly ok: number;
  readonly failed: number;
  readonly records: WriteRecord[];
}

/**
 * Run a blast against engines that already exist (one per sender). Orders alternate bid/ask at one
 * price so they cross and clear each other: the book never grows past the in-flight count and the
 * program's 256-per-side cap is never hit. Each transaction yields one `Placed` plus usually one `Filled`.
 */
export async function blast(engines: LabEngine[], opts: BlastOptions, onRecord?: (r: WriteRecord) => void): Promise<BlastResult> {
  const price = 1_000_000n + BigInt(Date.now() % 1_000_000);
  const records: WriteRecord[] = [];
  let next = 0;
  // Alternate side per engine so every program instance sees both sides and never fills its cap.
  const sideCounter = engines.map(() => 0);
  const t0 = performance.now();
  const worker = async (w: number) => {
    while (true) {
      const i = next++;
      if (i >= opts.total) return;
      const idx = (w + i) % engines.length;
      const engine = engines[idx];
      try {
        const rec = await engine.placeInjected(sideCounter[idx]++ % 2 === 0 ? SIDE_BID : SIDE_ASK, price, 1n);
        records.push(rec);
        onRecord?.(rec);
      } catch (err) {
        console.error('blast worker error', err);
      }
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency }, (_, w) => worker(w)));
  const wallMs = performance.now() - t0;
  const ok = records.filter((r) => !r.error).length;
  return {
    total: opts.total,
    concurrency: opts.concurrency,
    senders: engines.length,
    wallMs,
    preconfPerSec: (ok / wallMs) * 1000,
    ok,
    failed: records.length - ok,
    records,
  };
}

/** One engine per sender; if `mirrors` is given, senders are spread round-robin across those program instances. */
export async function openEngines(senders: number, firstSenderIndex = 5, mirrors?: `0x${string}`[]): Promise<{ engines: LabEngine[]; chains: Chain[] }> {
  const chains = await Promise.all(Array.from({ length: senders }, (_, i) => connectChain(firstSenderIndex + i, mirrors && mirrors.length ? mirrors[i % mirrors.length] : undefined)));
  const engines = await Promise.all(chains.map((c) => LabEngine.create(c)));
  return { engines, chains };
}
