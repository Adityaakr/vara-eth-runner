// Per-write timeline records and latency statistics. All timestamps are ms from one monotonic
// clock (`performance.now()`), so differences between hops are meaningful.
import type { Hex } from 'viem';

export type WritePath = 'injected' | 'l1';

export interface WriteRecord {
  /** Local id, assigned at submit time. */
  readonly n: number;
  readonly path: WritePath;
  readonly label: string;
  readonly payload: Hex;
  /** Wall-clock ms at submit, for display only. */
  readonly submittedAt: number;
  /** Monotonic ms when the write left this process. */
  tSubmit: number;
  /** Injected: validator-signed promise arrived. */
  tPreconf?: number;
  /** L1 path: sendMessage transaction mined on Anvil (MessageQueueingRequested visible). */
  tL1Mined?: number;
  /** Either path: the program's eth events for this write are visible as Mirror logs on Anvil. */
  tCommitted?: number;
  /** Ethereum block in which the committed events landed. */
  committedBlock?: bigint;
  /** Order id returned by the program (from the promise reply or the L1 Reply event). */
  orderId?: bigint;
  /** Ethereum block the write was anchored to (injected: reference block; l1: mined block). */
  ethBlock?: bigint;
  txHash?: Hex;
  messageId?: Hex;
  validator?: Hex;
  error?: string;
  /** Who signed: an Anvil dev account or a browser passkey-derived key. */
  signer?: 'anvil' | 'passkey';
  signerAddress?: Hex;
  /** L1 path: the program replied with an error; the write was mined, so mined timing still counts. */
  replyError?: string;
  /** How many times a reorg rebuild cleared this record's committed stamp. */
  uncommittedByReorg?: number;
}

export interface LatencySummary {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly min: number;
  readonly max: number;
}

export function summarize(samples: readonly number[]): LatencySummary | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  // nearest-rank percentile: p50 of [1,2] is 1, p95 of 20 samples is the 19th
  const pick = (q: number) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
  return { count: sorted.length, p50: pick(0.5), p95: pick(0.95), min: sorted[0], max: sorted[sorted.length - 1] };
}

export interface PathStats {
  /** Records excluded from every summary: failed writes and writes still awaiting a hop. */
  readonly excluded: { errored: number; uncommitted: number };
  readonly submitToPreconf: LatencySummary | null;
  readonly submitToL1Mined: LatencySummary | null;
  readonly submitToCommitted: LatencySummary | null;
  readonly preconfToCommitted: LatencySummary | null;
}

export function statsFor(records: readonly WriteRecord[], path: WritePath): PathStats {
  const all = records.filter((r) => r.path === path);
  const rs = all.filter((r) => !r.error);
  const diff = (a: (r: WriteRecord) => number | undefined, b: (r: WriteRecord) => number | undefined) =>
    rs.flatMap((r) => {
      const x = a(r);
      const y = b(r);
      return x !== undefined && y !== undefined ? [y - x] : [];
    });
  return {
    excluded: { errored: all.length - rs.length, uncommitted: rs.filter((r) => r.tCommitted === undefined).length },
    submitToPreconf: summarize(diff((r) => r.tSubmit, (r) => r.tPreconf)),
    submitToL1Mined: summarize(diff((r) => r.tSubmit, (r) => r.tL1Mined)),
    submitToCommitted: summarize(diff((r) => r.tSubmit, (r) => r.tCommitted)),
    preconfToCommitted: summarize(diff((r) => r.tPreconf, (r) => r.tCommitted)),
  };
}
