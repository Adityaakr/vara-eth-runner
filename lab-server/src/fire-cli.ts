// Throughput probe: pre-sign N injected `ping` transactions to the counter program, then fire them
// as fast as the RPC accepts them (no per-transaction subscription), while polling the program's
// own counter to measure how many the validator actually executed per second.
// Usage: tsx src/fire-cli.ts <total> <concurrency> <senders> [instances=all]   env: LAB_FIRST_SENDER
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { SailsProgram } from 'sails-js';
import { SailsIdlParser } from 'sails-js/parser';
import type { Hex } from 'viem';
import { connectChain } from './chain.js';
import { LAB_ROOT } from './config.js';

const total = Number(process.argv[2] ?? 2000);
const concurrency = Number(process.argv[3] ?? 64);
const senders = Number(process.argv[4] ?? 4);
const firstSender = Number(process.env.LAB_FIRST_SENDER ?? 5);
const mirrors = readFileSync(`${LAB_ROOT}/run/counters.txt`, 'utf8').split('\n').filter(Boolean) as Hex[];
const instances = Math.min(mirrors.length, Number(process.argv[5] ?? mirrors.length));
const targets = mirrors.slice(0, instances);

async function main() {
  const parser = new SailsIdlParser();
  await parser.init();
  const prog = new SailsProgram(parser.parse(readFileSync(`${LAB_ROOT}/counter/target/wasm32-gear/release/counter.idl`, 'utf8')));
  const ping = prog.services.Counter.functions.Ping.encodePayload() as Hex;
  const countPayload = prog.services.Counter.queries.Count.encodePayload() as Hex;
  const chains = await Promise.all(Array.from({ length: senders }, (_, i) => connectChain(firstSender + i, targets[i % targets.length])));
  const readCount = async (mirror: Hex) => {
    const r = await chains[0].api.call.program.calculateReplyForHandle(chains[0].sender.address, mirror, countPayload, 0n);
    return BigInt(String(prog.services.Counter.queries.Count.decodeResult(r.payload)).replace(/,/g, ''));
  };
  const sum = async () => (await Promise.all(targets.map(readCount))).reduce((a, b) => a + b, 0n);

  // 1. Pre-sign everything (measures the client's signing rate, which is NOT validator throughput).
  const head = await chains[0].publicClient.getBlock({ blockTag: 'latest' });
  const t0 = performance.now();
  const txs: Awaited<ReturnType<typeof chains[0]["api"]["createInjectedTransaction"]>>[] = [];
  for (let i = 0; i < total; i++) {
    const c = chains[i % senders];
    const tx = await c.api.createInjectedTransaction({ destination: targets[i % targets.length], payload: ping, value: 0n });
    Object.defineProperty(tx, '_bytesBasedOnVersion', { get: () => (tx as unknown as { _hashableBytes: Uint8Array })._hashableBytes });
    tx.setDefaultValidator();
    await tx.setReferenceBlock(head.hash);
    await tx.sign();
    txs.push(tx);
  }
  const signMs = performance.now() - t0;
  console.log(`pre-signed ${total} txs in ${(signMs / 1000).toFixed(2)} s (${((total / signMs) * 1000).toFixed(0)} sign/s, client-side)`);

  // Optional synchronised start so several processes fire together (LAB_FIRE_AT = epoch ms).
  const fireAt = Number(process.env.LAB_FIRE_AT ?? 0);
  if (fireAt > Date.now()) await new Promise((r) => setTimeout(r, fireAt - Date.now()));
  // 2. Fire, and sample the validator's counter every 200 ms.
  const before = await sum();
  const samples: { t: number; n: bigint }[] = [];
  const t1 = performance.now();
  const sampler = setInterval(() => void sum().then((n) => samples.push({ t: performance.now(), n })).catch(() => undefined), 200);
  let next = 0;
  let accepted = 0;
  let rejected = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = next++;
      if (i >= total) return;
      try {
        const res = await txs[i].send();
        if (JSON.stringify(res).includes('Reject')) { rejected++; if (rejected === 1) console.log('first rejection:', JSON.stringify(res)); } else accepted++;
      } catch {
        rejected++;
      }
    }
  }));
  const sendMs = performance.now() - t1;
  console.log(`sent ${accepted} accepted, ${rejected} rejected in ${(sendMs / 1000).toFixed(2)} s (${((accepted / sendMs) * 1000).toFixed(0)} submit/s)`);
  // 3. Wait until the counter has absorbed them (or 60 s).
  const target = before + BigInt(accepted);
  const deadline = performance.now() + 60_000;
  let now = await sum();
  while (now < target && performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    now = await sum();
  }
  clearInterval(sampler);
  const drainMs = performance.now() - t1;
  const executed = Number(now - before);
  // executed/s over the whole fire+drain window, and the best 1-second window from samples
  let best = 0;
  for (let i = 0; i < samples.length; i++) for (let j = i + 1; j < samples.length; j++) {
    const dt = samples[j].t - samples[i].t;
    if (dt >= 1000 && dt < 1400) best = Math.max(best, (Number(samples[j].n - samples[i].n) / dt) * 1000);
  }
  console.log(`validator executed ${executed} of ${accepted} accepted in ${(drainMs / 1000).toFixed(2)} s → ${((executed / drainMs) * 1000).toFixed(0)} executed/s average, best 1 s window ${best.toFixed(0)} executed/s`);
  await Promise.all(chains.map((c) => c.disconnect()));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
