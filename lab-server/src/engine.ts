// The experiment engine: sends orders over both paths, stamps every hop, and reads the
// validator's pre-confirmed view of the book.
import { performance } from 'node:perf_hooks';
import { decodeEventLog, encodeFunctionData, hexToString, type Hex } from 'viem';
import { IMIRROR_ABI } from '@vara-eth/api/abi';
import type { Chain } from './chain.js';
import { IDL_PATH } from './config.js';
import { OrderbookCodec } from './sails.js';
import type { WriteRecord } from './timeline.js';
import { L1Watcher, type ObservedEvent } from './l1watch.js';
import type { BookView } from './sails.js';

const RECEIPT_TIMEOUT_MS = Number(process.env.LAB_RECEIPT_TIMEOUT_MS ?? 10_000);

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export interface PreparedInjected {
  tx: Awaited<ReturnType<LabEngine['createInjectedTx']>>;
  rec: WriteRecord;
}

export class LabEngine {
  readonly records: WriteRecord[] = [];
  readonly watcher: L1Watcher;
  private nextN = 1;
  /** Record lists whose committed stamps this engine's watcher maintains (its own plus any tracked). */
  private readonly tracked: WriteRecord[][] = [this.records];

  private constructor(
    readonly chain: Chain,
    readonly codec: OrderbookCodec,
  ) {
    this.watcher = new L1Watcher(chain.publicClient, chain.mirrorAddress);
    this.watcher.onEvent((e) => this.onCommittedEvent(e));
    // After a reorg rebuild, nothing is committed until its logs are seen again on the new chain.
    this.watcher.onRebuild(() => {
      for (const r of this.allRecords()) {
        if (r.tCommitted !== undefined) r.uncommittedByReorg = (r.uncommittedByReorg ?? 0) + 1;
        r.tCommitted = undefined;
        r.committedBlock = undefined;
      }
    });
  }

  static async create(chain: Chain): Promise<LabEngine> {
    return new LabEngine(chain, await OrderbookCodec.load(IDL_PATH));
  }

  /** Let this engine's watcher attribute committed logs to another engine's records too. */
  trackRecords(records: WriteRecord[]): void {
    this.tracked.push(records);
  }

  allRecords(): WriteRecord[] {
    return this.tracked.flat();
  }

  /** Start following committed events on Anvil (backfills from genesis first). */
  async start(): Promise<void> {
    await this.watcher.start();
  }

  stop(): void {
    this.watcher.stop();
  }

  /** The Ethereum-committed view, replayed from Mirror logs only. */
  committedBook(): BookView {
    return this.watcher.book.view();
  }

  /** Injected transaction straight to the validator; resolves when the signed promise arrives. */
  async placeInjected(side: number, price: bigint, qty: bigint): Promise<WriteRecord> {
    const prepared = await this.prepareInjected(side, price, qty);
    await prepared.tx.sign();
    return this.sendPrepared(prepared, 'anvil', this.chain.sender.address);
  }

  /**
   * Build and anchor an injected transaction without signing it, so an external signer (a browser
   * passkey-derived key) can sign `tx.hash` and hand the signature back via `sendPrepared`.
   */
  async prepareInjected(side: number, price: bigint, qty: bigint): Promise<PreparedInjected> {
    const payload = this.codec.encodePlace(side, price, qty);
    const rec = this.newRecord('injected', `place ${sideLabel(side)} ${qty}@${price}`, payload);
    const tx = await this.createInjectedTx(payload);
    // Anchor at the current head (the library default is head-3) so "blocks from anchor" is comparable with L1.
    const head = await this.chain.publicClient.getBlock({ blockTag: 'latest' });
    await tx.setReferenceBlock(head.hash);
    rec.messageId = tx.messageId;
    rec.txHash = tx.txHash;
    rec.ethBlock = head.number;
    return { tx, rec };
  }

  /** Submit a prepared (already signed) injected transaction; timing starts here. */
  async sendPrepared({ tx, rec }: PreparedInjected, signer: 'anvil' | 'passkey', signerAddress: Hex): Promise<WriteRecord> {
    rec.signer = signer;
    rec.signerAddress = signerAddress;
    rec.tSubmit = performance.now();
    let receipt;
    try {
      // A validator occasionally never delivers a promise (observed ~1 in 100 under bursts); without a
      // bound the caller would wait forever and stall every loop behind it.
      receipt = await withTimeout(tx.sendAndWaitForReceipt(), RECEIPT_TIMEOUT_MS, `no validator receipt within ${RECEIPT_TIMEOUT_MS / 1000} s`);
    } catch (err) {
      rec.error = `send failed: ${err instanceof Error ? err.message : String(err)}`;
      return rec;
    }
    rec.tPreconf = performance.now();
    rec.validator = receipt.address;
    if (receipt.error !== null) {
      rec.error = `purged: ${receipt.error}`;
      return rec;
    }
    if (!receipt.promise.code.isSuccess) {
      rec.error = `program error: ${panicText(receipt.promise.payload) ?? receipt.promise.code.reason}`;
      return rec;
    }
    rec.orderId = this.codec.decodePlaceReply(receipt.promise.payload);
    return rec;
  }

  /**
   * Ordinary Ethereum transaction to the Mirror; resolves when Anvil mines it. The transaction is
   * prepared and signed before `tSubmit`, mirroring the injected path where signing is excluded.
   */
  async placeL1(side: number, price: bigint, qty: bigint): Promise<WriteRecord> {
    const payload = this.codec.encodePlace(side, price, qty);
    const rec = this.newRecord('l1', `place ${sideLabel(side)} ${qty}@${price}`, payload);
    const { publicClient, wallet, mirrorAddress } = this.chain;
    const data = encodeFunctionData({ abi: IMIRROR_ABI, functionName: 'sendMessage', args: [payload, false] });
    let signed: Hex;
    try {
      const request = await wallet.prepareTransactionRequest({ account: wallet.account!, chain: wallet.chain, to: mirrorAddress, data, value: 0n });
      signed = await wallet.signTransaction({ ...request, account: wallet.account!, chain: wallet.chain } as Parameters<typeof wallet.signTransaction>[0]);
    } catch (err) {
      rec.error = `prepare failed: ${String(err)}`;
      return rec;
    }
    rec.tSubmit = performance.now();
    try {
      rec.txHash = await publicClient.sendRawTransaction({ serializedTransaction: signed });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: rec.txHash, pollingInterval: 50 });
      rec.tL1Mined = performance.now();
      rec.ethBlock = receipt.blockNumber;
      if (receipt.status !== 'success') {
        rec.error = 'L1 transaction reverted';
        return rec;
      }
      for (const log of receipt.logs) {
        try {
          const ev = decodeEventLog({ abi: IMIRROR_ABI, data: log.data, topics: log.topics });
          if (ev.eventName === 'MessageQueueingRequested') rec.messageId = (ev.args as { id: Hex }).id;
        } catch {
          /* other logs */
        }
      }
    } catch (err) {
      rec.error = `send failed: ${String(err)}`;
    }
    return rec;
  }

  /** The validator's current (pre-confirmed) view, via a dry-run query at its latest computed block. */
  async preconfBook(): Promise<BookView> {
    const reply = await this.chain.api.call.program.calculateReplyForHandle(
      this.chain.sender.address,
      this.chain.mirrorAddress,
      this.codec.encodeBookQuery(),
      0n,
    );
    if (!reply.code.isSuccess) throw new Error(`book query failed: ${reply.code.reason}`);
    return this.codec.decodeBookReply(reply.payload);
  }

  async preconfSeq(): Promise<bigint> {
    const reply = await this.chain.api.call.program.calculateReplyForHandle(
      this.chain.sender.address,
      this.chain.mirrorAddress,
      this.codec.encodeSeqQuery(),
      0n,
    );
    if (!reply.code.isSuccess) throw new Error(`seq query failed: ${reply.code.reason}`);
    return this.codec.decodeSeqReply(reply.payload);
  }

  /**
   * Attribute committed logs to write records. Injected writes know their order id from the
   * promise, so their `Placed` log matches directly. L1 writes learn their id from the Mirror's
   * `Reply` log (replyTo == messageId), which lands in the same block as their `Placed` log.
   */
  private onCommittedEvent(obs: ObservedEvent): void {
    const ev = obs.event;
    if (ev.kind === 'Reply') {
      const rec = this.allRecords().find((r) => r.path === 'l1' && r.messageId === ev.replyTo);
      if (!rec || rec.orderId !== undefined) return;
      if (ev.replyCode.startsWith('0x00')) {
        try {
          rec.orderId = this.codec.decodePlaceReply(ev.payload);
        } catch (err) {
          rec.error = `undecodable reply: ${String(err)}`;
          return;
        }
      } else {
        rec.replyError = `reply error code ${ev.replyCode}`;
        return;
      }
      const placed = this.watcher.observed.find((o) => o.event.kind === 'Placed' && o.event.id === rec.orderId);
      if (placed) this.markCommitted(rec, placed);
      return;
    }
    if (ev.kind !== 'Placed') return;
    // Newest first: after a node restart order ids restart at 1 and must bind to the newest record.
    const rec = [...this.allRecords()].reverse().find((r) => r.orderId === ev.id && r.tCommitted === undefined);
    if (rec) this.markCommitted(rec, obs);
  }

  private markCommitted(rec: WriteRecord, obs: ObservedEvent): void {
    if (rec.tCommitted !== undefined) return;
    rec.tCommitted = obs.tSeen;
    rec.committedBlock = obs.blockNumber;
  }

  /**
   * The gear v2.0.0 node expects the *legacy* RPC envelope (`AddressedInjectedTransaction {recipient, tx}`)
   * but signs the *current* digest (`InjectedTransaction::to_hashable_bytes`: destination ‖ keccak(payload)
   * ‖ value ‖ reference_block ‖ keccak(salt), then EIP-191). @vara-eth/api 0.6.0-rc.0 ties both choices to
   * the node's `version` RPC, which v2.0.0 lacks, so it would sign the old byte layout and the node rejects
   * it with "Address mismatch". Overriding the digest source on the instance reconciles the two.
   */
  async createInjectedTx(payload: Hex) {
    const tx = await this.chain.api.createInjectedTransaction({
      destination: this.chain.mirrorAddress,
      payload,
      value: 0n,
    });
    const hashable = tx as unknown as { _hashableBytes: Uint8Array };
    Object.defineProperty(tx, '_bytesBasedOnVersion', { get: () => hashable._hashableBytes });
    tx.setDefaultValidator();
    return tx;
  }

  private newRecord(path: WriteRecord['path'], label: string, payload: Hex): WriteRecord {
    const rec: WriteRecord = { n: this.nextN++, path, label, payload, submittedAt: Date.now(), tSubmit: 0 };
    this.records.push(rec);
    return rec;
  }

}

/** Error replies carry the panic message as a plain string payload (gstd-panic-message). */
function panicText(payload: Hex): string | null {
  try {
    const text = hexToString(payload).replace(/[^\x20-\x7e]/g, '').trim();
    return text.length > 0 ? text.slice(0, 120) : null;
  } catch {
    return null;
  }
}

function sideLabel(side: number): string {
  return side === 0 ? 'bid' : 'ask';
}
