// Server-render the viewer with one real snapshot from the running lab-server and assert on it.
import { renderToString } from 'react-dom/server';
import WebSocket from '../../lab-server/node_modules/ws/index.js';
import { LabView } from '../src/App';
import type { Snapshot } from '../src/types';

async function main() {
const snap = await new Promise<Snapshot>((resolve, reject) => {
  const ws = new WebSocket('ws://127.0.0.1:8787');
  ws.on('message', (m: Buffer) => {
    const s = JSON.parse(String(m));
    if (s.type === 'snapshot') {
      ws.close();
      resolve(s as Snapshot);
    }
  });
  ws.on('error', reject);
});
const html = renderToString(<LabView snap={snap} lastError={null} send={() => {}} />);
const must = ['Pre-confirmation telemetry', 'Median pre-confirm', 'Pre-confirmed transactions per second', 'Latency distribution', 'Transactions', 'Ethereum settlement', 'Comparison and fault injection', `event sequence ${snap.preconf.seq}`];
const missing = must.filter((m) => !html.includes(m));
if (missing.length) {
  console.error('render-check FAILED, missing:', missing);
  process.exit(1);
}
const empty = renderToString(<LabView snap={{ ...snap, preconf: { seq: '0', next_id: '1', bids: [], asks: [], recent_fills: [] }, committed: { seq: '0', next_id: '1', bids: [], asks: [], recent_fills: [] }, records: [], blocks: [], preconfError: 'validator down', latency: { preconf: null, e2e: null, histogram: [] }, blast: { running: false, last: null }, autopilot: { rate: 0, running: false }, network: snap.network, validator: snap.validator, totals: { ...snap.totals, allTimeMinMs: null } }} lastError="boom" send={() => {}} />);
if (!empty.includes('not answering state queries') || !empty.includes('No transactions yet')) {
  console.error('render-check FAILED on empty/error snapshot');
  process.exit(1);
}
console.log(`render-check OK: ${html.length} chars, ${snap.records.length} records, pre.seq=${snap.preconf.seq} com.seq=${snap.committed.seq}, gap badge present=${html.includes('badge')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
