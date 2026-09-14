// Reorg matrix: for each (canonical quarantine, reorg depth) cell, seed committed and pre-confirmed
// orders, force an Anvil reorg, and observe what the validator and the committed view do.
// Usage: npm run reorg-matrix -- [--quarantine 0,4] [--depth 1,3,6] [--observe 40]
import { performance } from 'node:perf_hooks';
import { connectChain } from './chain.js';
import { LabEngine } from './engine.js';
import { writeReport } from './report.js';
import { SIDE_ASK } from './sails.js';
import { anvilReorg, deployProgram, nodeRefusedCommitments, restartNode, waitForNodeReady } from './stack.js';
import type { WriteRecord } from './timeline.js';

interface CellResult {
  quarantine: number;
  depth: number;
  committedSeqBeforeReorg: bigint;
  preconfSeqBeforeReorg: bigint;
  /** Committed seq sampled 1 s after the reorg (Anvil's log index lags the reorg for a moment). */
  committedSeqAfterRebuild: bigint | null;
  /** Lowest committed seq seen during the observation window: how far the committed view fell back. */
  minCommittedSeqAfterReorg: bigint;
  reorgDetectedMs: number | null;
  /** Ethereum head when the reorg was requested; the reorg re-mines (head-depth, head]. */
  headAtReorg: bigint;
  /** Highest block holding a seeded order's commit log; inside the reorg window iff > headAtReorg - depth. */
  seededCommitBlock: bigint;
  seededCommitInsideWindow: boolean;
  /** Were the two in-flight orders really uncommitted when the reorg fired? */
  inFlightUncommittedAtReorg: boolean;
  /** Orders pre-confirmed but not yet committed when the reorg struck. */
  inFlight: { orderId: bigint; committedAfterMs: number | null }[];
  /** Orders committed before the reorg: did their logs survive / come back? */
  seeded: { orderId: bigint; block: bigint; stillCommittedAtEnd: boolean }[];
  /** One more injected write sent 5 s after the reorg. */
  postReorgWrite: { outcome: string; committedAfterMs: number | null };
  recoveredMs: number | null;
  refusedCommitmentsLogLines: number;
  notes: string[];
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const QUARANTINES = arg('quarantine', '0,4').split(',').map(Number);
const DEPTHS = arg('depth', '1,3,6').split(',').map(Number);
const OBSERVE_MS = Number(arg('observe', '40')) * 1000;

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function until(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
  return true;
}

async function runCell(quarantine: number, depth: number): Promise<CellResult> {
  console.log(`\n=== cell quarantine=${quarantine} depth=${depth} ===`);
  restartNode(quarantine);
  deployProgram();
  const chain = await connectChain(3);
  await waitForNodeReady(chain.publicClient);
  const engine = await LabEngine.create(chain);
  await engine.start();
  const notes: string[] = [];
  const base = 10_000n + BigInt(depth) * 100n + BigInt(quarantine);

  // 1. Seed three orders and wait until they are committed on Ethereum.
  const seededRecs: WriteRecord[] = [];
  for (let i = 0; i < 3; i++) seededRecs.push(await engine.placeInjected(SIDE_ASK, base + BigInt(i), 1n));
  if (!(await until(() => seededRecs.every((r) => r.tCommitted !== undefined), 30_000))) notes.push('seed orders never committed');

  // 2. Two in-flight orders (pre-confirmed only), then the reorg.
  const inFlightRecs: WriteRecord[] = [];
  for (let i = 0; i < 2; i++) inFlightRecs.push(await engine.placeInjected(SIDE_ASK, base + 10n + BigInt(i), 1n));
  const committedSeqBeforeReorg = engine.committedBook().seq;
  const preconfSeqBeforeReorg = await engine.preconfSeq();
  const inFlightUncommittedAtReorg = inFlightRecs.every((r) => r.tCommitted === undefined);
  const seededCommitBlock = seededRecs.reduce((m, r) => (r.committedBlock !== undefined && r.committedBlock > m ? r.committedBlock : m), 0n);
  const headAtReorg = await chain.publicClient.getBlockNumber();
  const refusedBefore = nodeRefusedCommitments();
  let reorgDetectedMs: number | null = null;
  let committedSeqAfterRebuild: bigint | null = null;
  engine.watcher.onReorg(() => {
    if (reorgDetectedMs === null) reorgDetectedMs = performance.now() - tReorg;
  });
  const tReorg = performance.now();
  await anvilReorg(chain.publicClient, depth);
  const detected = await until(() => reorgDetectedMs !== null, 5_000);
  if (!detected) notes.push('watcher never detected the reorg');
  let minCommittedSeqAfterReorg = engine.committedBook().seq;
  const tSample = Date.now();
  while (Date.now() < tSample + 1_000) {
    const c = engine.committedBook().seq;
    if (c < minCommittedSeqAfterReorg) minCommittedSeqAfterReorg = c;
    await sleep(50);
  }
  committedSeqAfterRebuild = engine.committedBook().seq;

  // 3. A write after the reorg: is the validator still accepting and committing?
  await sleep(5_000);
  const post = await engine.placeInjected(SIDE_ASK, base + 20n, 1n);
  const postOutcome = post.error ?? `promise in ${(post.tPreconf! - post.tSubmit).toFixed(0)}ms`;

  // 4. Observe recovery.
  const tObserveStart = performance.now();
  let recoveredMs: number | null = null;
  const observeDeadline = Date.now() + OBSERVE_MS;
  while (Date.now() < observeDeadline) {
    const pre = await engine.preconfSeq();
    if (engine.committedBook().seq < minCommittedSeqAfterReorg) minCommittedSeqAfterReorg = engine.committedBook().seq;
    if (engine.committedBook().seq >= pre && recoveredMs === null) {
      recoveredMs = performance.now() - tReorg;
    }
    if (recoveredMs !== null && post.tCommitted !== undefined && inFlightRecs.every((r) => r.tCommitted !== undefined)) break;
    await sleep(100);
  }
  void tObserveStart;
  const committedNow = engine.committedBook();
  const result: CellResult = {
    quarantine,
    depth,
    committedSeqBeforeReorg,
    preconfSeqBeforeReorg,
    committedSeqAfterRebuild,
    minCommittedSeqAfterReorg,
    reorgDetectedMs,
    headAtReorg,
    seededCommitBlock,
    seededCommitInsideWindow: seededCommitBlock > headAtReorg - BigInt(depth),
    inFlightUncommittedAtReorg,
    inFlight: inFlightRecs.map((r) => ({ orderId: r.orderId!, committedAfterMs: r.tCommitted === undefined ? null : r.tCommitted - tReorg })),
    seeded: seededRecs.map((r) => ({ orderId: r.orderId!, block: r.committedBlock!, stillCommittedAtEnd: committedNow.asks.some((o) => o.id === r.orderId) })),
    postReorgWrite: { outcome: postOutcome, committedAfterMs: post.tCommitted === undefined ? null : post.tCommitted - tReorg },
    recoveredMs,
    refusedCommitmentsLogLines: nodeRefusedCommitments() - refusedBefore,
    notes,
  };
  console.log(JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  engine.stop();
  await chain.disconnect();
  return result;
}

async function main() {
  const results: CellResult[] = [];
  for (const q of QUARANTINES) for (const d of DEPTHS) results.push(await runCell(q, d));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const md = [
    `# Reorg matrix — ${new Date().toISOString()}`,
    '',
    'Per cell: fresh node with the given canonical quarantine; 3 orders committed on Ethereum, 2 more pre-confirmed',
    'but not yet committed; then `anvil_reorg(depth)` drops and re-mines that many blocks empty (commit txs are lost).',
    `A further order is sent 5 s after the reorg. Observation window ${OBSERVE_MS / 1000} s. "(re)committed after reorg" is the time`,
    'the log was seen on the post-reorg chain (committed stamps are cleared on every watcher rebuild). "committed caught up" means',
    'the committed seq reached the pre-confirmed seq at some point in the window; "post-reorg write committed" is the real liveness signal.',
    '',
    '| quarantine | depth | reorg detected | seeded commit block in window | in-flight uncommitted at reorg | committed seq before → 1 s after (min seen) | in-flight (re)committed after reorg | post-reorg write | seeded still committed | committed caught up | node refused commitments |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) =>
      `| ${r.quarantine} | ${r.depth} | ${r.reorgDetectedMs === null ? 'NO' : `+${r.reorgDetectedMs.toFixed(0)}ms`} | ${r.seededCommitInsideWindow ? `yes (block ${r.seededCommitBlock}, head ${r.headAtReorg})` : `no (block ${r.seededCommitBlock}, head ${r.headAtReorg})`} | ${r.inFlightUncommittedAtReorg ? 'yes' : 'NO'} | ${r.committedSeqBeforeReorg} → ${r.committedSeqAfterRebuild} (min ${r.minCommittedSeqAfterReorg}) | ${r.inFlight.map((f) => (f.committedAfterMs === null ? `#${f.orderId} never` : `#${f.orderId} +${(f.committedAfterMs / 1000).toFixed(1)}s`)).join(', ')} | ${r.postReorgWrite.outcome}${r.postReorgWrite.committedAfterMs === null ? ', never committed' : `, committed +${(r.postReorgWrite.committedAfterMs / 1000).toFixed(1)}s`} | ${r.seeded.filter((s) => s.stillCommittedAtEnd).length}/${r.seeded.length} | ${r.recoveredMs === null ? 'no' : `yes, +${(r.recoveredMs / 1000).toFixed(1)}s`} | ${r.refusedCommitmentsLogLines > 0 ? `yes (${r.refusedCommitmentsLogLines} log lines)` : 'no'} |`,
    ),
    '',
    '## Notes',
    ...results.flatMap((r) => r.notes.map((n) => `- q${r.quarantine} d${r.depth}: ${n}`)),
    '',
  ].join('\n');
  const paths = writeReport(`reorg-matrix-${stamp}`, results, md);
  console.log('\n' + md);
  console.log(`report: ${paths.mdPath}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
