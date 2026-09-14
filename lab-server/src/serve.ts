// WebSocket server for the explorer UI: streams engine snapshots and executes UI commands.
// Usage: npm run serve  (ws://127.0.0.1:8787)
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { WebSocketServer, type WebSocket } from 'ws';
import type { BlastResult } from './blast.js';
import { connectChain } from './chain.js';
import { bigintReplacer } from './committed.js';
import { LAB_ROOT, LEDGER_IDL_PATH, ledgerAddress, nodeSettings } from './config.js';
import { LedgerCodec } from './sails.js';
import { existsSync, readFileSync } from 'node:fs';
import { LabEngine, type PreparedInjected } from './engine.js';
import type { Hex } from 'viem';
import { anvilReorg, deployProgramAsync, restartNodeAsync } from './stack.js';
import { statsFor, summarize, type WriteRecord } from './timeline.js';
import { NetEmulator, calibrate, profiles, type NetProfile } from './netem.js';
import { VARA_ETH_RPC_DIRECT } from './config.js';

const PORT = Number(process.env.LAB_WS_PORT ?? 8787);
const BLAST_SENDERS = 4;
const HISTORY_SECONDS = 180;
const RECENT_MAX = 4000;
const DEFAULT_AUTOPILOT_RATE = Number(process.env.LAB_AUTOPILOT_RATE ?? 12);
/** The dev node persists every micro-block to an unpruned --tmp RocksDB (64 GB in 40 min at 25 tx/s) and slows
 * as it grows. The server recycles the stack on a timer and whenever the validator's own execution latency
 * (measured minus emulated wire) creeps, and says so on the page. */
const RECYCLE_EVERY_MIN = Number(process.env.LAB_RECYCLE_MINUTES ?? 30);
/** Recycle when the node's --tmp store exceeds this size. The store, not latency, is the real trigger:
 * latency also rises from queueing under load and would recycle in a loop at high rates. */
const RECYCLE_STORE_GB = Number(process.env.LAB_RECYCLE_STORE_GB ?? 8);
const NETEM_PORT = Number(process.env.LAB_NETEM_PORT ?? 9945);
const CALIBRATION_URL = process.env.LAB_CALIBRATE_URL ?? 'wss://rpc.vara.network';
const DEFAULT_NET_PROFILE = (process.env.LAB_NET_PROFILE ?? 'measured') as NetProfile['name'];

type Command =
  | { type: 'place'; path: 'injected' | 'l1'; side: number; price: string; qty: string }
  | { type: 'reorg'; depth: number }
  | { type: 'blast'; total: number; concurrency: number }
  | { type: 'autopilot'; rate: number }
  | { type: 'network'; profile: NetProfile['name'] }
  | { type: 'recycle' }
  | { type: 'prepare'; kind?: 'place'; side: number; price: string; qty: string }
  | { type: 'prepare'; kind: 'transfer'; to: string; amount: string }
  | { type: 'prepare'; kind: 'faucet' }
  | { type: 'balance'; address: string }
  | { type: 'submitSigned'; prepId: string; signature: string; address: string };

/** performance.now() → wall-clock ms, using the record's own submit pair as the reference. */
function wallOf(r: WriteRecord, t: number | undefined): number | undefined {
  return t === undefined ? undefined : r.submittedAt + (t - r.tSubmit);
}

async function main() {
  // Network emulation: every engine (this process and its children) talks to the validator through
  // a proxy that delays frames by a calibrated one-way latency. Calibration is a live round trip to
  // Gear's public Vara RPC, i.e. the region where Vara.eth validators are hosted.
  const ledgerAddr = ledgerAddress();
  const ledger = ledgerAddr ? await LedgerCodec.load(LEDGER_IDL_PATH) : null;
  const cal = await calibrate(CALIBRATION_URL, 'system_chain');
  const table = profiles(cal);
  const netem = new NetEmulator(VARA_ETH_RPC_DIRECT, table[DEFAULT_NET_PROFILE] ?? table.measured);
  netem.listen(NETEM_PORT);
  process.env.VARA_ETH_RPC_WS = `ws://127.0.0.1:${NETEM_PORT}`;
  console.log(`network emulation: ${netem.profile.name} (${netem.profile.note}); one-way ${netem.profile.oneWayMs.toFixed(0)} ms`);
  let chain = await connectChain(4);
  let engine = await LabEngine.create(chain);
  await engine.start();
  const validator = { startedAt: Date.now(), recycles: 0, lastRecycleAt: null as number | null, recycling: false, lastReason: '' };
  // Blast records come from a child process (see runBlast) so signing and RPC traffic never share
  // this server's event loop with snapshot serialization; committed attribution still happens here.
  // Records from child processes (autopilot traffic and bursts) live in one bounded ring so the
  // snapshot maths stays cheap; all-time totals are kept as counters.
  const recent: WriteRecord[] = [];
  const allTime = { txs: 0, preconfirmed: 0, failed: 0, minMs: Infinity, sumMs: 0 };
  const ingest = (r: WriteRecord) => {
    recent.push(r);
    if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
    allTime.txs++;
    if (r.error) allTime.failed++;
    else if (r.tPreconf !== undefined) {
      allTime.preconfirmed++;
      const ms = r.tPreconf - r.tSubmit;
      allTime.minMs = Math.min(allTime.minMs, ms);
      allTime.sumMs += ms;
    }
  };
  engine.trackRecords(recent);

  const recycle = async (reason: string) => {
    if (validator.recycling) return;
    validator.recycling = true;
    validator.lastReason = reason;
    console.log(`recycle: ${reason}`);
    try {
      setAutopilot(0);
      blastChild?.kill('SIGTERM');
      engine.stop();
      await chain.disconnect().catch(() => undefined);
      await restartNodeAsync(nodeSettings().quarantine);
      await deployProgramAsync();
      chain = await connectChain(4);
      engine = await LabEngine.create(chain);
      await engine.start();
      for (const r of recent) { r.tCommitted = undefined; r.committedBlock = undefined; }
      engine.trackRecords(recent);
      validator.startedAt = Date.now();
      validator.recycles++;
      validator.lastRecycleAt = Date.now();
      setAutopilot(DEFAULT_AUTOPILOT_RATE);
    } finally {
      validator.recycling = false;
    }
  };
  setInterval(() => {
    if (!blastState.running && Date.now() - validator.startedAt > RECYCLE_EVERY_MIN * 60_000) void recycle(`scheduled every ${RECYCLE_EVERY_MIN} min`).catch((e) => console.error('recycle failed', e));
  }, 15_000);
  const storeGb = (): number => {
    try {
      const dir = execSync("ls -td \"${TMPDIR:-/tmp}\"/ethexe* 2>/dev/null | head -1", { encoding: 'utf8' }).trim();
      if (!dir) return 0;
      return Number(execSync(`du -sk "${dir}" | cut -f1`, { encoding: 'utf8' }).trim()) / 1024 / 1024;
    } catch {
      return 0;
    }
  };
  let lastStoreGb = 0;
  setInterval(() => {
    if (validator.recycling || blastState.running) return;
    lastStoreGb = storeGb();
    if (lastStoreGb > RECYCLE_STORE_GB) void recycle(`validator store ${lastStoreGb.toFixed(1)} GB > ${RECYCLE_STORE_GB} GB`).catch((e) => console.error('recycle failed', e));
  }, 30_000);
  let autopilot: { child: ChildProcess | null; rate: number } = { child: null, rate: 0 };
  const setAutopilot = (rate: number) => {
    if (autopilot.child) {
      autopilot.child.kill('SIGTERM');
      autopilot = { child: null, rate: 0 };
    }
    if (rate <= 0) return;
    const mirrorsFile = resolve(LAB_ROOT, 'run/mirrors.txt');
    // Traffic uses at most the first 4 instances; a 5th, if deployed, stays quiet for the live tests.
    const mirrors = existsSync(mirrorsFile) ? readFileSync(mirrorsFile, 'utf8').split('\n').filter(Boolean).slice(0, 4).join(',') : '';
    const child = spawn(process.execPath, [tsxBin(), resolve(dirname(fileURLToPath(import.meta.url)), 'traffic-cli.ts'), String(rate), String(BLAST_SENDERS)], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LAB_MIRRORS: mirrors } });
    child.stderr.on('data', (d) => process.stderr.write(`[traffic] ${d}`));
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const msg = JSON.parse(line) as { record?: Record<string, unknown> };
        if (msg.record) ingest(reviveRecord(msg.record));
      } catch {
        /* not JSON */
      }
    });
    child.on('exit', (code) => {
      if (autopilot.child === child) autopilot = { child: null, rate: 0 };
      if (code && code !== 0) console.error(`traffic child exited ${code}`);
    });
    autopilot = { child, rate };
  };
  setAutopilot(DEFAULT_AUTOPILOT_RATE);
  process.on('exit', () => autopilot.child?.kill('SIGTERM'));

  const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
  console.log(`lab-server listening on ws://127.0.0.1:${PORT}; mirror ${chain.mirrorAddress}`);

  let lastPreconf = await engine.preconfBook();
  let preconfError: string | null = null;
  let blastState: { running: boolean; last: Omit<BlastResult, 'records'> | null } = { running: false, last: null };
  let blastChild: ChildProcess | null = null;
  const blockMeta = new Map<bigint, { hash: string; timestamp: number }>();
  const prepared = new Map<string, { p: PreparedInjected; at: number; decode?: (payload: Hex) => bigint }>();
  let prepSeq = 0;

  const throughputSeries = (records: WriteRecord[], now: number) => {
    const buckets = Array.from({ length: HISTORY_SECONDS }, (_, i) => ({ t: Math.floor(now / 1000) * 1000 - (HISTORY_SECONDS - 1 - i) * 1000, preconf: 0, committed: 0, latencies: [] as number[], p50: null as number | null }));
    const first = buckets[0].t;
    for (const r of records) {
      const p = wallOf(r, r.tPreconf);
      if (p !== undefined && p >= first) {
        const b = buckets[Math.min(HISTORY_SECONDS - 1, Math.floor((p - first) / 1000))];
        b.preconf++;
        b.latencies.push(r.tPreconf! - r.tSubmit);
      }
      const c = wallOf(r, r.tCommitted);
      if (c !== undefined && c >= first) buckets[Math.min(HISTORY_SECONDS - 1, Math.floor((c - first) / 1000))].committed++;
    }
    return buckets.map(({ latencies, ...b }) => ({ ...b, p50: summarize(latencies)?.p50 ?? null }));
  };

  const blockRows = async () => {
    const counts = new Map<bigint, number>();
    for (const o of engine.watcher.observed) if (o.event.kind !== 'Reply') counts.set(o.blockNumber, (counts.get(o.blockNumber) ?? 0) + 1);
    const head = await chain.publicClient.getBlockNumber();
    const rows = [];
    for (let n = head; n > head - 20n && n >= 0n; n--) {
      let meta = blockMeta.get(n);
      if (!meta) {
        const b = await chain.publicClient.getBlock({ blockNumber: n });
        meta = { hash: b.hash, timestamp: Number(b.timestamp) };
        blockMeta.set(n, meta);
      }
      rows.push({ number: n, hash: meta.hash, timestamp: meta.timestamp, txs: counts.get(n) ?? 0 });
    }
    return rows;
  };

  const snapshot = async () => {
    // The book query is a dry-run execution on the validator; during a blast it would compete with
    // the transactions being measured, so the last known book is shown instead.
    if (validator.recycling) {
      preconfError = null; // the old connection is gone by design; not a validator fault
    } else if (!blastState.running) {
      try {
        lastPreconf = await engine.preconfBook();
        preconfError = null;
      } catch (err) {
        preconfError = shortErr(err);
      }
    }
    const now = Date.now();
    const records = engine.allRecords().sort((a, b) => a.submittedAt - b.submittedAt).slice(-RECENT_MAX);
    const injected = records.filter((r) => r.path === 'injected' && !r.error && r.tPreconf !== undefined);
    const preconfLatencies = injected.map((r) => r.tPreconf! - r.tSubmit);
    const preconfLat = summarize(preconfLatencies);
    const edges = [0, 5, 10, 20, 50, 100, 200, 500, Infinity];
    const histogram = edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1], count: preconfLatencies.filter((x) => x >= lo && x < edges[i + 1]).length }));
    const e2e = summarize(records.filter((r) => !r.error && r.tCommitted !== undefined).map((r) => r.tCommitted! - r.tSubmit));
    const series = throughputSeries(records, now);
    // Fine series: 500 ms buckets over the same window for the dense band.
    const FINE_MS = 500;
    const fineCount = (HISTORY_SECONDS * 1000) / FINE_MS;
    const fineStart = Math.floor(now / FINE_MS) * FINE_MS - (fineCount - 1) * FINE_MS;
    const fine = new Array<number>(fineCount).fill(0);
    for (const r of records) {
      const p = wallOf(r, r.tPreconf);
      if (p !== undefined && p >= fineStart) fine[Math.min(fineCount - 1, Math.floor((p - fineStart) / FINE_MS))]++;
    }
    // Per-transaction latency points for the last HISTORY_SECONDS, thinned to a bounded count.
    const windowStart = now - HISTORY_SECONDS * 1000;
    const rawPoints = injected
      .map((r) => ({ t: wallOf(r, r.tPreconf)!, ms: r.tPreconf! - r.tSubmit, signer: r.signer ?? 'anvil' }))
      .filter((p) => p.t >= windowStart);
    const stride = Math.max(1, Math.ceil(rawPoints.length / 1800));
    const points = rawPoints.filter((_, i) => i % stride === 0);
    const lastSecond = series[series.length - 2]; // the last complete second
    return JSON.stringify(
      {
        type: 'snapshot',
        now,
        mirror: chain.mirrorAddress,
        sender: chain.sender.address,
        node: nodeSettings(),
        ledger: ledgerAddr,
        ethHead: await chain.publicClient.getBlockNumber().catch(() => 0n),
        preconf: lastPreconf,
        preconfError,
        committed: engine.committedBook(),
        watcher: engine.watcher.state(),
        totals: {
          txs: allTime.txs + engine.records.length,
          preconfirmed: allTime.preconfirmed + engine.records.filter((r) => r.path === 'injected' && !r.error && r.tPreconf !== undefined).length,
          committed: records.filter((r) => r.tCommitted !== undefined).length,
          failed: allTime.failed + engine.records.filter((r) => r.error).length,
          pending: records.filter((r) => !r.error && !r.untracked && r.tCommitted === undefined).length,
          allTimeMinMs: Number.isFinite(allTime.minMs) ? allTime.minMs : null,
          allTimeMeanMs: allTime.preconfirmed ? allTime.sumMs / allTime.preconfirmed : null,
        },
        autopilot: { rate: autopilot.rate, running: autopilot.child !== null },
        validator: { startedAt: validator.startedAt, uptimeSec: Math.floor((Date.now() - validator.startedAt) / 1000), recycles: validator.recycles, lastRecycleAt: validator.lastRecycleAt, recycling: validator.recycling, lastReason: validator.lastReason, recycleEveryMin: RECYCLE_EVERY_MIN, storeGb: lastStoreGb, storeLimitGb: RECYCLE_STORE_GB },
        network: { profile: netem.profile.name, oneWayMs: netem.profile.oneWayMs, jitterMs: netem.profile.jitterMs, note: netem.profile.note, calibration: cal, profiles: Object.values(table).map((p) => ({ name: p.name, oneWayMs: p.oneWayMs, note: p.note })) },
        latency: { preconf: preconfLat, e2e, histogram },
        throughput: { series, lastSecond: lastSecond.preconf, peak: Math.max(...series.map((b) => b.preconf)) },
        points,
        windowSeconds: HISTORY_SECONDS,
        fine: { start: fineStart, stepMs: FINE_MS, counts: fine },
        blocks: await blockRows().catch(() => []),
        records: records.slice(-40).map((r) => ({ ...r, wallPreconf: wallOf(r, r.tPreconf), wallCommitted: wallOf(r, r.tCommitted) })),
        stats: { injected: statsFor(records, 'injected'), l1: statsFor(records, 'l1') },
        blast: blastState,
      },
      bigintReplacer,
    );
  };

  let broadcasting = false;
  const broadcast = async () => {
    if (wss.clients.size === 0 || broadcasting) return;
    broadcasting = true;
    try {
      const msg = await snapshot();
      for (const c of wss.clients) if (c.readyState === c.OPEN) safeSend(c, msg);
    } finally {
      broadcasting = false;
    }
  };
  const tick = () => {
    void broadcast().catch((e) => console.error('broadcast', e));
    setTimeout(tick, blastState.running ? 1000 : 250);
  };
  tick();

  wss.on('connection', (ws: WebSocket) => {
    void snapshot()
      .then((m) => safeSend(ws, m))
      .catch((err) => safeSend(ws, JSON.stringify({ type: 'error', message: String(err) })));
    ws.on('message', (raw) => {
      let cmd: Command;
      try {
        cmd = JSON.parse(String(raw)) as Command;
      } catch {
        return;
      }
      void handle(cmd)
        .then((reply) => reply && safeSend(ws, JSON.stringify(reply)))
        .catch((err) => safeSend(ws, JSON.stringify({ type: 'error', message: String(err) })));
    });
  });

  async function handle(cmd: Command): Promise<object | void> {
    if (cmd.type === 'place') {
      const [price, qty] = [BigInt(cmd.price), BigInt(cmd.qty)];
      if (cmd.path === 'injected') await engine.placeInjected(cmd.side, price, qty);
      else await engine.placeL1(cmd.side, price, qty);
    } else if (cmd.type === 'reorg') {
      const depth = Number(cmd.depth);
      if (!Number.isInteger(depth) || depth < 1 || depth > 50) throw new Error('reorg depth must be an integer between 1 and 50');
      await anvilReorg(chain.publicClient, depth);
    } else if (cmd.type === 'recycle') {
      void recycle('requested from the page').catch((e) => console.error('recycle failed', e));
    } else if (cmd.type === 'network') {
      const p = table[cmd.profile];
      if (!p) throw new Error('unknown network profile');
      netem.profile = p;
    } else if (cmd.type === 'autopilot') {
      const rate = Math.min(300, Math.max(0, Number(cmd.rate) || 0));
      setAutopilot(rate);
    } else if (cmd.type === 'balance') {
      if (!ledger || !ledgerAddr) throw new Error('ledger not deployed');
      const who = cmd.address.toLowerCase() as Hex;
      const balance = ledger.decodeBalance(await engine.queryRaw(ledgerAddr, ledger.encodeBalanceOf(who)));
      return { type: 'balance', address: who, balance: balance.toString() };
    } else if (cmd.type === 'prepare') {
      let p: PreparedInjected;
      let decode: ((payload: Hex) => bigint) | undefined;
      if (cmd.kind === 'transfer') {
        if (!ledger || !ledgerAddr) throw new Error('ledger not deployed');
        const to = cmd.to.toLowerCase() as Hex;
        const amount = BigInt(cmd.amount);
        if (!/^0x[0-9a-f]{40}$/.test(to)) throw new Error('recipient must be a 20-byte hex address');
        if (amount <= 0n) throw new Error('amount must be positive');
        p = await engine.prepareCall(ledgerAddr, ledger.encodeTransfer(to, amount), `transfer ${amount} → ${to.slice(0, 6)}…${to.slice(-4)}`);
        decode = (x) => ledger.decodeTransferReply(x);
      } else if (cmd.kind === 'faucet') {
        if (!ledger || !ledgerAddr) throw new Error('ledger not deployed');
        p = await engine.prepareCall(ledgerAddr, ledger.encodeFaucet(), 'faucet');
        decode = (x) => ledger.decodeFaucetReply(x);
      } else {
        p = await engine.prepareInjected(Number(cmd.side), BigInt(cmd.price), BigInt(cmd.qty));
      }
      const prepId = String(++prepSeq);
      prepared.set(prepId, { p, at: Date.now(), decode });
      for (const [k, v] of prepared) if (Date.now() - v.at > 120_000) prepared.delete(k);
      return { type: 'prepared', prepId, hash: p.tx.hash, messageId: p.tx.messageId };
    } else if (cmd.type === 'submitSigned') {
      const entry = prepared.get(cmd.prepId);
      if (!entry) throw new Error('unknown or expired prepId');
      prepared.delete(cmd.prepId);
      const signature = cmd.signature as Hex;
      const address = cmd.address.toLowerCase() as Hex;
      await entry.p.tx.sign({
        signMessage: async () => signature,
        getAddress: async () => address,
        signTypedData: async () => {
          throw new Error('not supported');
        },
      });
      const rec = await engine.sendPrepared(entry.p, 'passkey', address, entry.decode);
      return { type: 'submitted', prepId: cmd.prepId, orderId: rec.orderId?.toString() ?? null, result: rec.orderId?.toString() ?? null, preconfMs: rec.tPreconf !== undefined ? rec.tPreconf - rec.tSubmit : null, error: rec.error ?? null };
    } else if (cmd.type === 'blast') {
      if (blastState.running) throw new Error('a load test is already running');
      if (validator.recycling) throw new Error('the validator is being recycled; try again in a moment');
      const total = Math.min(5000, Math.max(1, Number(cmd.total) || 0));
      const concurrency = Math.min(256, Math.max(1, Number(cmd.concurrency) || 0));
      blastState = { running: true, last: blastState.last };
      const t0 = performance.now();
      try {
        const summary = await runBlast(total, concurrency, BLAST_SENDERS, ingest, (c) => (blastChild = c));
        blastState = { running: false, last: summary };
      } catch (err) {
        blastState = { running: false, last: blastState.last };
        throw err;
      } finally {
        blastChild = null;
        console.log(`blast ${total}@${concurrency} took ${(performance.now() - t0).toFixed(0)} ms`);
      }
    }
  }
}

/** Run blast-cli.ts as a child process and stream its records back. */
function runBlast(total: number, concurrency: number, senders: number, onRecord: (r: WriteRecord) => void, onSpawn?: (c: ChildProcess) => void): Promise<Omit<BlastResult, 'records'>> {
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), 'blast-cli.ts');
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [tsxBin(), cli, String(total), String(concurrency), String(senders), '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    onSpawn?.(child);
    let summary: Omit<BlastResult, 'records'> | null = null;
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += String(d)));
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const msg = JSON.parse(line) as { record?: Record<string, unknown>; summary?: Omit<BlastResult, 'records'> };
        if (msg.record) onRecord(reviveRecord(msg.record));
        if (msg.summary) summary = msg.summary;
      } catch {
        /* not JSON */
      }
    });
    child.on('exit', (code, signal) => {
      if (code === 0 && summary) resolvePromise(summary);
      else if (signal) reject(new Error('load test stopped because the validator was recycled'));
      else reject(new Error(`load test failed: ${stderr.split('\n').find((l) => l.includes('shortMessage') || l.includes('Error'))?.slice(0, 160) ?? `exit ${code}`}`));
    });
  });
}

function tsxBin(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.bin', 'tsx');
}

/** JSON lost the bigints (serialized as strings); restore the fields the engine compares by. */
function reviveRecord(raw: Record<string, unknown>): WriteRecord {
  const big = (k: string) => (typeof raw[k] === 'string' ? BigInt(raw[k] as string) : undefined);
  return { ...(raw as unknown as WriteRecord), orderId: big('orderId'), ethBlock: big('ethBlock'), committedBlock: undefined, tCommitted: undefined };
}

function shortErr(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  return (e?.shortMessage ?? e?.message ?? String(err)).split('\n')[0].slice(0, 140);
}

function safeSend(ws: WebSocket, msg: string): void {
  try {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  } catch (err) {
    console.error('ws send failed', err);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
