// Report writers shared by the benchmark and the reorg matrix.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LAB_ROOT } from './config.js';
import { bigintReplacer } from './committed.js';
import { POLL_INTERVAL_MS } from './l1watch.js';
import type { LatencySummary, PathStats, WriteRecord } from './timeline.js';

export const REPORTS_DIR = resolve(LAB_ROOT, 'reports');

export function writeReport(name: string, json: unknown, markdown: string): { jsonPath: string; mdPath: string } {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const jsonPath = resolve(REPORTS_DIR, `${name}.json`);
  const mdPath = resolve(REPORTS_DIR, `${name}.md`);
  writeFileSync(jsonPath, JSON.stringify(json, bigintReplacer, 2));
  writeFileSync(mdPath, markdown);
  return { jsonPath, mdPath };
}

export function fmt(s: LatencySummary | null): string {
  if (!s) return 'n/a';
  return `n=${s.count} p50=${s.p50.toFixed(0)}ms p95=${s.p95.toFixed(0)}ms min=${s.min.toFixed(0)} max=${s.max.toFixed(0)}`;
}

export function statsTable(injected: PathStats, l1: PathStats): string {
  const excl = (p: PathStats) => `excluded: ${p.excluded.errored} errored, ${p.excluded.uncommitted} never committed`;
  const rows: Array<[string, LatencySummary | null, LatencySummary | null]> = [
    ['submit → pre-confirmed (validator promise)', injected.submitToPreconf, l1.submitToPreconf],
    ['submit → mined on Ethereum (L1 tx receipt)', injected.submitToL1Mined, l1.submitToL1Mined],
    ['submit → committed (program logs on Ethereum)', injected.submitToCommitted, l1.submitToCommitted],
    ['pre-confirmed → committed', injected.preconfToCommitted, l1.preconfToCommitted],
  ];
  return [
    '| hop | injected | L1 Mirror.sendMessage |',
    '|---|---|---|',
    ...rows.map(([h, a, b]) => `| ${h} | ${fmt(a)} | ${fmt(b)} |`),
    '',
    `Committed times are when this process observed the log: mined time + up to one ${POLL_INTERVAL_MS} ms poll + a getLogs round trip.`,
    `Injected: signing and reference-block fetch happen before submit. L1: the tx is prepared and signed before submit; submit = sendRawTransaction.`,
    `Injected ${excl(injected)}; L1 ${excl(l1)}. Excluded records are absent from every percentile above.`,
  ].join('\n');
}

export function blockLag(records: readonly WriteRecord[], path: WriteRecord['path']): string {
  const lags = records
    .filter((r) => r.path === path && r.ethBlock !== undefined && r.committedBlock !== undefined)
    .map((r) => Number(r.committedBlock! - r.ethBlock!));
  if (lags.length === 0) return 'n/a';
  const sorted = [...lags].sort((a, b) => a - b);
  return `blocks from anchor to commit: min ${sorted[0]}, median ${sorted[Math.floor(sorted.length / 2)]}, max ${sorted[sorted.length - 1]}`;
}
