// Samples the counter programs' totals for a fixed duration and reports executed/s: average over
// the active window and the best 1-second window. Run alongside fire-cli processes.
// Usage: tsx src/sample-cli.ts <seconds>
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { SailsProgram } from 'sails-js';
import { SailsIdlParser } from 'sails-js/parser';
import type { Hex } from 'viem';
import { connectChain } from './chain.js';
import { LAB_ROOT } from './config.js';

const seconds = Number(process.argv[2] ?? 30);
const mirrors = readFileSync(`${LAB_ROOT}/run/counters.txt`, 'utf8').split('\n').filter(Boolean) as Hex[];

async function main() {
  const parser = new SailsIdlParser();
  await parser.init();
  const prog = new SailsProgram(parser.parse(readFileSync(`${LAB_ROOT}/counter/target/wasm32-gear/release/counter.idl`, 'utf8')));
  const countPayload = prog.services.Counter.queries.Count.encodePayload() as Hex;
  const chain = await connectChain(4, mirrors[0]);
  const read = async (m: Hex) => {
    const r = await chain.api.call.program.calculateReplyForHandle(chain.sender.address, m, countPayload, 0n);
    return BigInt(String(prog.services.Counter.queries.Count.decodeResult(r.payload)).replace(/,/g, ''));
  };
  const sum = async () => (await Promise.all(mirrors.map(read))).reduce((a, b) => a + b, 0n);
  const samples: { t: number; n: bigint }[] = [];
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) {
    samples.push({ t: performance.now(), n: await sum() });
    await new Promise((r) => setTimeout(r, 150));
  }
  // active window = from first increase to last increase
  let first = -1, last = -1;
  for (let i = 1; i < samples.length; i++) if (samples[i].n > samples[i - 1].n) { if (first < 0) first = i - 1; last = i; }
  let best = 0;
  for (let i = 0; i < samples.length; i++) for (let j = i + 1; j < samples.length; j++) {
    const dt = samples[j].t - samples[i].t;
    if (dt >= 1000 && dt < 1300) best = Math.max(best, (Number(samples[j].n - samples[i].n) / dt) * 1000);
  }
  if (first < 0) { console.log('no executions observed'); } else {
    const executed = Number(samples[last].n - samples[first].n);
    const dt = (samples[last].t - samples[first].t) / 1000;
    console.log(`sampler: ${executed} executed over ${dt.toFixed(2)} s active → ${(executed / dt).toFixed(0)} executed/s average · best 1 s window ${best.toFixed(0)} executed/s · ${mirrors.length} programs`);
  }
  await chain.disconnect();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
