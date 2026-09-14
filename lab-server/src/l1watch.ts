// Reorg-safe watcher for the program's committed events on Anvil. Polls new blocks, verifies the
// previously seen head is still canonical, and rebuilds from genesis when it is not.
//
// Timing caveat: `tSeen` is when this process observed a log, i.e. mine time + up to one poll
// interval + the getLogs round trip. All logs returned by one poll share a stamp.
import { performance } from 'node:perf_hooks';
import { decodeEventLog, type Address, type Hex, type Log, type PublicClient } from 'viem';
import { ORDERBOOK_EVENTS_ABI } from './abi.js';
import { CommittedBook, type BookEvent } from './committed.js';

export interface ObservedEvent {
  readonly event: BookEvent;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly txHash: Hex;
  /** Monotonic ms when this process first saw the log (see caveat above). */
  readonly tSeen: number;
}

export interface WatcherState {
  readonly headNumber: bigint;
  readonly headHash: Hex;
  readonly reorgs: number;
  readonly lastReorgAt?: number;
  readonly rpcErrors: number;
}

export const POLL_INTERVAL_MS = 50;

export class L1Watcher {
  readonly book = new CommittedBook();
  readonly observed: ObservedEvent[] = [];
  private headNumber = -1n;
  private headHash: Hex = '0x';
  private reorgs = 0;
  private rpcErrors = 0;
  private lastReorgAt?: number;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private listeners: Array<(e: ObservedEvent) => void> = [];
  private reorgListeners: Array<() => void> = [];
  private rebuildListeners: Array<() => void> = [];

  constructor(
    private readonly client: PublicClient,
    private readonly mirror: Address,
    private readonly intervalMs = POLL_INTERVAL_MS,
  ) {}

  onEvent(fn: (e: ObservedEvent) => void): void {
    this.listeners.push(fn);
  }

  /** Fired when the last seen head is no longer canonical, before the rebuild. */
  onReorg(fn: () => void): void {
    this.reorgListeners.push(fn);
  }

  /** Fired after the book and observed list were cleared; consumers must drop derived state. */
  onRebuild(fn: () => void): void {
    this.rebuildListeners.push(fn);
  }

  state(): WatcherState {
    return { headNumber: this.headNumber, headHash: this.headHash, reorgs: this.reorgs, lastReorgAt: this.lastReorgAt, rpcErrors: this.rpcErrors };
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.rebuild();
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.poll();
      } catch (err) {
        // A failed ingest may have applied part of a batch: the book is untrustworthy, rebuild.
        this.rpcErrors++;
        console.error('l1watch poll failed, rebuilding', err);
        await this.rebuild().catch((e) => console.error('l1watch rebuild failed', e));
      } finally {
        if (!this.stopped) this.timer = setTimeout(tick, this.intervalMs);
      }
    };
    this.timer = setTimeout(tick, this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** One polling step; exposed for tests. Throws on RPC failure (caller rebuilds). */
  async poll(): Promise<void> {
    const head = await this.client.getBlockNumber();
    if (this.headNumber >= 0n) {
      let canonical: boolean;
      if (head < this.headNumber) {
        canonical = false; // chain got shorter: certainly a reorg
      } else {
        const still = await this.client.getBlock({ blockNumber: this.headNumber }); // throws on RPC error, not a reorg
        canonical = still.hash === this.headHash;
      }
      if (!canonical) {
        this.reorgs++;
        this.lastReorgAt = performance.now();
        for (const fn of this.reorgListeners) safely(fn);
        await this.rebuild();
        return;
      }
    }
    if (head <= this.headNumber) return;
    await this.ingest(this.headNumber + 1n, head);
  }

  private async rebuild(): Promise<void> {
    this.book.reset();
    this.observed.length = 0;
    this.headNumber = -1n;
    this.headHash = '0x';
    for (const fn of this.rebuildListeners) safely(fn);
    const head = await this.client.getBlockNumber();
    await this.ingest(0n, head);
  }

  /**
   * Ingest logs in [from, to]. The hash of `to` is read before and after getLogs; if it changed,
   * a reorg raced the fetch and the caller must rebuild (thrown as an error).
   */
  private async ingest(from: bigint, to: bigint): Promise<void> {
    const before = await this.client.getBlock({ blockNumber: to });
    const logs = await this.client.getLogs({ address: this.mirror, fromBlock: from, toBlock: to });
    const after = await this.client.getBlock({ blockNumber: to });
    if (after.hash !== before.hash) throw new Error(`reorg during getLogs at block ${to}`);
    const tSeen = performance.now();
    const events: ObservedEvent[] = [];
    for (const log of logs) {
      const event = decode(log);
      if (!event) continue;
      events.push({ event, blockNumber: log.blockNumber!, blockHash: log.blockHash!, txHash: log.transactionHash!, tSeen });
    }
    // Apply all before notifying so a listener exception cannot leave the book half-updated.
    for (const obs of events) this.book.apply(obs.event);
    this.observed.push(...events);
    this.headNumber = to;
    this.headHash = after.hash;
    for (const obs of events) for (const fn of this.listeners) safely(() => fn(obs));
  }
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error('l1watch listener failed', err);
  }
}

function decode(log: Log): BookEvent | null {
  let decoded;
  try {
    decoded = decodeEventLog({ abi: ORDERBOOK_EVENTS_ABI, data: log.data, topics: log.topics });
  } catch {
    return null; // Mirror's own events (StateChanged, MessageQueueingRequested, ...) are not ours
  }
  const a = decoded.args as Record<string, unknown>;
  switch (decoded.eventName) {
    case 'Placed':
      return { kind: 'Placed', id: a.id as bigint, seq: a.seq as bigint, owner: (a.owner as string).toLowerCase() as Hex, side: Number(a.side), price: a.price as bigint, qty: a.qty as bigint };
    case 'Filled':
      return { kind: 'Filled', taker: a.taker as bigint, maker: a.maker as bigint, seq: a.seq as bigint, price: a.price as bigint, qty: a.qty as bigint };
    case 'Cancelled':
      return { kind: 'Cancelled', id: a.id as bigint, seq: a.seq as bigint };
    case 'Reply':
      return { kind: 'Reply', replyTo: a.replyTo as Hex, payload: a.payload as Hex, replyCode: a.replyCode as Hex };
  }
}
