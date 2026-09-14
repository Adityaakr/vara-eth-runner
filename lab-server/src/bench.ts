// Latency benchmark: N orders per path, sequential, then wait for every write to be committed.
// Usage: npm run bench -- [N]
import { connectChain } from './chain.js';
import { LabEngine } from './engine.js';
import { blockLag, statsTable, writeReport } from './report.js';
import { SIDE_ASK, SIDE_BID } from './sails.js';
import { statsFor } from './timeline.js';

const N = Number(process.argv[2] ?? 30);

async function main() {
  const chain = await connectChain(2);
  const engine = await LabEngine.create(chain);
  await engine.start();
  const started = Date.now();
  // Non-crossing prices keep every order resting; the committed replay is exercised with Placed only.
  const base = 100_000n + BigInt(Date.now() % 100_000) * 10n;
  for (let i = 0; i < N; i++) {
    const rec = await engine.placeInjected(SIDE_ASK, base + BigInt(i), 1n);
    if (rec.error) console.error('injected', i, rec.error);
  }
  for (let i = 0; i < N; i++) {
    const rec = await engine.placeL1(SIDE_BID, 1n + BigInt(i), 1n);
    if (rec.error) console.error('l1', i, rec.error);
  }
  const deadline = Date.now() + 120_000;
  while (engine.records.some((r) => !r.error && r.tCommitted === undefined) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const pending = engine.records.filter((r) => !r.error && r.tCommitted === undefined).length;
  const injected = statsFor(engine.records, 'injected');
  const l1 = statsFor(engine.records, 'l1');
  const finalPre = await engine.preconfBook();
  const finalCommitted = engine.committedBook();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const md = [
    `# Pre-confirmation latency benchmark — ${new Date().toISOString()}`,
    '',
    `Local stack: gear v2.0.0 ethexe dev node, single validator, Anvil 1 s blocks, canonical quarantine 0.`,
    `N = ${N} orders per path, sent sequentially from one sender. Wall time ${((Date.now() - started) / 1000).toFixed(1)} s.`,
    '',
    statsTable(injected, l1),
    '',
    `- injected: ${blockLag(engine.records, 'injected')} (anchor = reference block)`,
    `- L1: ${blockLag(engine.records, 'l1')} (anchor = block the sendMessage tx was mined in)`,
    `- writes still uncommitted at the end: ${pending}`,
    `- final seq: pre-confirmed ${finalPre.seq}, committed ${finalCommitted.seq}`,
    '',
    '## Per-write records',
    '',
    '| n | path | label | order | preconf ms | mined ms | committed ms | anchor block | commit block | error |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...engine.records.map((r) =>
      `| ${r.n} | ${r.path} | ${r.label} | ${r.orderId ?? ''} | ${ms(r.tPreconf, r.tSubmit)} | ${ms(r.tL1Mined, r.tSubmit)} | ${ms(r.tCommitted, r.tSubmit)} | ${r.ethBlock ?? ''} | ${r.committedBlock ?? ''} | ${r.error ?? ''} |`,
    ),
    '',
  ].join('\n');
  const paths = writeReport(`bench-${stamp}`, { n: N, injected, l1, records: engine.records }, md);
  console.log(md.split('\n').slice(0, 14).join('\n'));
  console.log(`\nreport: ${paths.mdPath}`);
  engine.stop();
  await chain.disconnect();
  process.exit(0);
}

function ms(t: number | undefined, t0: number): string {
  return t === undefined ? '' : (t - t0).toFixed(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
