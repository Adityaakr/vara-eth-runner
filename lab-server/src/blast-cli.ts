// Usage: npm run blast -- [total] [concurrency] [senders] [--json]
// With --json, prints one JSON line per completed record and a final {"summary": ...} line, so a
// parent process (the dashboard server) can run the blast out of its own event loop.
import { blast, openEngines } from './blast.js';
import { bigintReplacer } from './committed.js';
import { summarize } from './timeline.js';

const args = process.argv.slice(2).filter((a) => a !== '--json');
const json = process.argv.includes('--json');
const total = Number(args[0] ?? 200);
const concurrency = Number(args[1] ?? 16);
const senders = Number(args[2] ?? 4);
const firstSender = Number(process.env.LAB_FIRST_SENDER ?? 5);
const mirrors = (process.env.LAB_MIRRORS ?? '').split(',').filter(Boolean) as `0x${string}`[];

async function main() {
  const { engines, chains } = await openEngines(senders, firstSender, mirrors);
  const res = await blast(engines, { total, concurrency, senders }, json ? (r) => console.log(JSON.stringify({ record: r }, bigintReplacer)) : undefined);
  const lat = summarize(res.records.filter((r) => !r.error && r.tPreconf !== undefined).map((r) => r.tPreconf! - r.tSubmit));
  if (json) {
    const { records: _r, ...summary } = res;
    console.log(JSON.stringify({ summary }));
  } else {
    console.log(`blast: ${res.ok}/${res.total} pre-confirmed in ${(res.wallMs / 1000).toFixed(2)} s = ${res.preconfPerSec.toFixed(0)} preconf/s (concurrency ${concurrency}, ${senders} senders)`);
    if (lat) console.log(`submit→preconf ms: min ${lat.min.toFixed(0)} p50 ${lat.p50.toFixed(0)} p95 ${lat.p95.toFixed(0)} max ${lat.max.toFixed(0)}`);
    const errors = new Map<string, number>();
    for (const r of res.records) if (r.error) errors.set(r.error.slice(0, 80), (errors.get(r.error.slice(0, 80)) ?? 0) + 1);
    for (const [e, n] of errors) console.log(`  ${n}× ${e}`);
  }
  await Promise.all(chains.map((c) => c.disconnect()));
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
