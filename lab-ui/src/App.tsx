import { useEffect, useRef, useState } from 'react';
import { useLab } from './useLab';
import { createPasskey, forgetPasskey, passkeysSupported, rememberedCredential, signInWithPasskey, signInjectedHash, type PasskeySession } from './passkey';
import type { BookView, Order, Snapshot, WriteRecord } from './types';

const STUCK_AFTER_MS = 15_000;
const ms0 = (x?: number | null, d = 0) => (x === undefined || x === null ? '—' : x.toFixed(d));
const short = (h?: string) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '');
const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour12: false }) + '.' + String(t % 1000).padStart(3, '0');
const preconfOf = (r: WriteRecord) => (r.tPreconf !== undefined ? r.tPreconf - r.tSubmit : undefined);
const n = (x: number) => x.toLocaleString();
type Req = <T>(cmd: object, replyType: string) => Promise<T>;

export default function App() {
  const lab = useLab();
  if (!lab.snap) {
    return (
      <div>
        <div className="mast"><div className="mark"><img src="/vara-eth-logo.svg" alt="Vara.eth" />VARA.ETH <span>Pre-confirmation telemetry</span></div><div className="meta"><span className="chip off"><i />{lab.status === 'open' ? 'connecting' : 'server offline'}</span></div></div>
        <div className="page"><p className="note">Start the telemetry server: <code>cd lab-server && npm run serve</code></p></div>
      </div>
    );
  }
  return <LabView snap={lab.snap} lastError={lab.lastError} send={lab.send} request={lab.request} />;
}

/** Pure view of one snapshot; also rendered server-side by scripts/render-check.tsx. */
export function LabView({ snap, lastError, send, request }: { snap: Snapshot; lastError: string | null; send: (cmd: object) => void; request?: Req }) {
  const [wallet, setWallet] = useState(false);
  const [session, setSession] = useState<PasskeySession | null>(null);
  const stuck = snap.records.filter((r) => !r.error && r.tCommitted === undefined && snap.now - r.submittedAt > STUCK_AFTER_MS).length;
  const live = !snap.preconfError && stuck === 0;
  const pre = snap.latency.preconf;
  const safeDepth = snap.node.quarantine + 1;
  const gap = Number(snap.preconf.seq) - Number(snap.committed.seq);
  return (
    <div>
      <div className="mast">
        <div className="mark"><img src="/vara-eth-logo.svg" alt="Vara.eth" />VARA.ETH <span>Pre-confirmation telemetry</span></div>
        <div className="meta">
          <span className={`chip ${live ? '' : 'off'}`}><i />{live ? 'Validator live' : 'Degraded'}</span>
          <span>Local network · 1 validator · 4 program instances</span>
          <span className="mono">{`Ethereum block ${snap.ethHead}`}</span>
          <button className="btn" onClick={() => setWallet(true)}>{session ? `Wallet · ${session.address.slice(0, 6)}…${session.address.slice(-4)}` : 'Wallet'}</button>
        </div>
      </div>
      <div className="page">
        {lastError && <div className="alert">Command rejected · {lastError}</div>}
        {snap.preconfError && <div className="alert">The validator is not answering state queries · {snap.preconfError.slice(0, 120)}</div>}
        {stuck > 0 && <div className="alert">{`${stuck} pre-confirmed transaction${stuck > 1 ? 's have' : ' has'} not settled on Ethereum for over ${STUCK_AFTER_MS / 1000} s. The validator continues to pre-confirm but is no longer committing, the signature of a reorg deeper than its anchor. Restart with run/start-node.sh.`}</div>}

        <div className="ribbon">
          <div className="kpi hero"><div className="k">Pre-confirmation · median</div><div className="v mint">{ms0(pre?.p50)}<u>ms</u></div><div className="s">{pre ? `n = ${n(pre.count)} recent` : 'awaiting traffic'}</div></div>
          <div className="kpi hero"><div className="k">Pre-confirmation · p95</div><div className="v">{ms0(pre?.p95)}<u>ms</u></div><div className="s">{pre ? `p99 proxy: max ${ms0(pre.max)} ms` : ''}</div></div>
          <div className="kpi hero"><div className="k">Fastest observed</div><div className="v mint">{ms0(snap.totals.allTimeMinMs, 1)}<u>ms</u></div><div className="s">since server start</div></div>
          <div className="kpi"><div className="k">Throughput</div><div className="v">{n(snap.throughput.lastSecond)}<u>tx/s</u></div><div className="s">{`peak ${n(snap.throughput.peak)} tx/s in the last 3 min`}</div></div>
          <div className="kpi"><div className="k">Transactions</div><div className="v">{n(snap.totals.txs)}</div><div className="s">{`${n(snap.totals.preconfirmed)} pre-confirmed · ${snap.totals.failed} rejected`}</div></div>
          <div className="kpi"><div className="k">Settled on Ethereum</div><div className="v">{n(snap.totals.committed)}</div><div className="s">{`${n(snap.totals.pending)} awaiting settlement`}</div></div>
        </div>

        <Toolbar send={send} snap={snap} />

        <div className="grid">
          <div className="panel">
            <h2>Throughput and latency <span className="r">last 180 s · one-second resolution</span></h2>
            <Chart series={snap.throughput.series} />
            <p className="note">Area: transactions pre-confirmed per second. Line: median pre-confirmation latency in that second. Latency is measured from submission to receipt of the validator-signed execution result on one monotonic clock; signing is excluded.</p>
          </div>
          <div className="panel">
            <h2>Latency distribution <span className="r">recent pre-confirmations</span></h2>
            <Histogram bins={snap.latency.histogram} />
          </div>
        </div>

        <div className="panel" style={{ marginTop: 14 }}>
          <h2>Transactions <span className="r">{`newest first · ${n(snap.totals.preconfirmed)} pre-confirmed`}</span></h2>
          <TxTable records={snap.records} mine={session?.address} />
        </div>

        <div className="grid2">
          <div className="panel">
            <h2>Ethereum settlement <span className="r">program events committed per block</span></h2>
            <table>
              <thead><tr><th>Height</th><th>Block hash</th><th className="r">Settled tx</th><th className="r">Time</th></tr></thead>
              <tbody>{snap.blocks.slice(0, 10).map((b) => <tr key={b.number}><td className="mono">{b.number}</td><td className="mono dim2">{short(b.hash)}</td><td className="r mono">{n(b.txs)}</td><td className="r mono dim">{new Date(b.timestamp * 1000).toLocaleTimeString(undefined, { hour12: false })}</td></tr>)}</tbody>
            </table>
          </div>
          <div className="panel">
            <h2>Settlement and safety</h2>
            <table className="kv">
              <tbody>
                <tr><td>Pre-confirmation → settlement, median</td><td>{snap.stats.injected.preconfToCommitted ? `${(snap.stats.injected.preconfToCommitted.p50 / 1000).toFixed(2)} s` : '—'}</td></tr>
                <tr><td>Ethereum transaction, time to mine, median</td><td>{snap.stats.l1.submitToL1Mined ? `${(snap.stats.l1.submitToL1Mined.p50 / 1000).toFixed(2)} s` : '—'}</td></tr>
                <tr><td>Validator state vs Ethereum state</td><td>{gap === 0 ? <span className="tag mint">identical</span> : <span className="tag amber">{`validator ahead by ${gap}`}</span>}</td></tr>
                <tr><td>Validator anchor depth</td><td>{`${safeDepth} block${safeDepth === 1 ? '' : 's'}`}</td></tr>
                <tr><td>Ethereum block time</td><td>{`${snap.node.blockTime} s`}</td></tr>
                <tr><td>Reorganisations observed</td><td>{snap.watcher.reorgs}</td></tr>
              </tbody>
            </table>
            <p className="note">A pre-confirmation is the validator's signed execution result and is available within milliseconds. Settlement occurs when the Router commits a batch to Ethereum and the program's events appear in the Mirror contract's logs, typically one to three blocks later. Until then the result is backed by the validator's signature, not by Ethereum.</p>
          </div>
        </div>

        <details className="panel" style={{ marginTop: 14 }}>
          <summary><h2>Comparison and fault injection <span className="r">Ethereum transaction path · forced reorganisation · dual view of program state</span></h2></summary>
          <Stress send={send} snap={snap} safeDepth={safeDepth} />
        </details>
        <p className="note dim">{`Program instance ${snap.mirror} · single local validator on one machine; figures are measured, not quoted.`}</p>
      </div>
      {wallet && <Wallet session={session} setSession={setSession} request={request} onClose={() => setWallet(false)} records={snap.records} />}
    </div>
  );
}

function Chart({ series }: { series: Snapshot['throughput']['series'] }) {
  const w = 1000;
  const h = 170;
  const maxTps = Math.max(10, ...series.map((b) => b.preconf));
  const maxMs = Math.max(20, ...series.map((b) => b.p50 ?? 0));
  const bw = w / series.length;
  const area = series.map((b, i) => `${(i * bw).toFixed(1)},${(h - (b.preconf / maxTps) * h).toFixed(1)}`).join(' ');
  const pts = series.map((b, i) => (b.p50 === null ? null : `${(i * bw + bw / 2).toFixed(1)},${(h - (b.p50 / maxMs) * h * 0.85).toFixed(1)}`));
  const segs: string[] = [];
  let cur: string[] = [];
  for (const p of pts) { if (p) cur.push(p); else if (cur.length) { segs.push(cur.join(' ')); cur = []; } }
  if (cur.length) segs.push(cur.join(' '));
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#00e6b8" stopOpacity="0.55" /><stop offset="1" stopColor="#00e6b8" stopOpacity="0.02" /></linearGradient></defs>
        {[0.25, 0.5, 0.75].map((f) => <line key={f} x1={0} x2={w} y1={h * f} y2={h * f} stroke="#183029" strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
        <polygon points={`0,${h} ${area} ${w},${h}`} fill="url(#area)" />
        <polyline points={area} fill="none" stroke="#00e6b8" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        {segs.map((s, i) => <polyline key={i} points={s} fill="none" stroke="#6cb5ff" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeDasharray="4 3" />)}
      </svg>
      <span className="lbl tl">{`${maxTps} tx/s`}</span>
      <span className="lbl tr">{`${maxMs.toFixed(0)} ms`}</span>
    </div>
  );
}

function Histogram({ bins }: { bins: Snapshot['latency']['histogram'] }) {
  const total = bins.reduce((a, b) => a + b.count, 0);
  const max = Math.max(1, ...bins.map((b) => b.count));
  if (total === 0) return <p className="note">No pre-confirmations yet.</p>;
  return (
    <div>
      <div className="hist">
        {bins.map((b) => (
          <div key={b.lo} style={{ display: 'contents' }}>
            <div className="lab">{b.hi === Infinity || b.hi === null ? `≥ ${b.lo}` : `${b.lo}–${b.hi}`}</div>
            <div className={`bar ${b.lo >= 100 ? 'hot' : ''}`}><i style={{ width: `${(b.count / max) * 100}%` }} /></div>
            <div className="cnt">{`${((b.count / total) * 100).toFixed(0)}%`}</div>
          </div>
        ))}
      </div>
      <p className="note">Milliseconds from submission to signed result, {n(total)} most recent transactions. Buckets at or above 100 ms are shaded amber.</p>
    </div>
  );
}

function Toolbar({ send, snap }: { send: (cmd: object) => void; snap: Snapshot }) {
  const [rate, setRate] = useState(String(snap.autopilot.rate || 60));
  const [burst, setBurst] = useState('1000');
  const [conc, setConc] = useState('64');
  const last = snap.blast.last;
  return (
    <div className="toolbar">
      <b>Traffic generator</b>
      <span className="stat">{snap.autopilot.running ? `${snap.autopilot.rate} tx/s steady, periodic 250-tx surges` : 'paused'}</span>
      <input value={rate} onChange={(e) => setRate(e.target.value)} />
      <button className="btn line" onClick={() => send({ type: 'autopilot', rate: Number(rate) })}>Apply rate</button>
      <button className="btn line" disabled={!snap.autopilot.running} onClick={() => send({ type: 'autopilot', rate: 0 })}>Pause</button>
      <span className="sep" />
      <b>Load test</b>
      <input value={burst} onChange={(e) => setBurst(e.target.value)} /><span>transactions</span>
      <input value={conc} onChange={(e) => setConc(e.target.value)} /><span>in flight</span>
      <button className="btn" disabled={snap.blast.running} onClick={() => send({ type: 'blast', total: Number(burst), concurrency: Number(conc) })}>{snap.blast.running ? 'Running…' : 'Run'}</button>
      {last && !snap.blast.running && <span className="stat">{`Last run: ${n(last.ok)} / ${n(last.total)} in ${(last.wallMs / 1000).toFixed(2)} s · ${last.preconfPerSec.toFixed(0)} tx/s sustained`}</span>}
    </div>
  );
}

function TxTable({ records, mine }: { records: WriteRecord[]; mine?: string }) {
  const rows = [...records].reverse().slice(0, 20);
  const seen = useRef(new Set<string>());
  const keyOf = (r: WriteRecord) => `${r.submittedAt}-${r.n}-${r.signerAddress ?? ''}`;
  useEffect(() => { for (const r of rows) seen.current.add(keyOf(r)); });
  if (rows.length === 0) return <p className="note">No transactions yet.</p>;
  const scale = Math.max(50, ...rows.map((r) => preconfOf(r) ?? 0));
  return (
    <table>
      <thead><tr><th>Time</th><th>Transaction</th><th>Account</th><th>Call</th><th className="r">Pre-confirmation</th><th className="r">Settlement</th></tr></thead>
      <tbody>
        {rows.map((r) => {
          const k = keyOf(r);
          const isMine = !!mine && r.signerAddress?.toLowerCase() === mine.toLowerCase();
          const lat = preconfOf(r);
          return (
            <tr key={k} className={`${isMine ? 'mine' : ''} ${seen.current.has(k) ? '' : 'fresh'}`}>
              <td className="mono dim2">{clock(r.submittedAt)}</td>
              <td className="mono dim2">{short(r.txHash ?? r.messageId)}</td>
              <td>{r.path === 'l1' ? <span className="tag">Ethereum tx</span> : r.signer === 'passkey' ? <span className="tag mint">Passkey</span> : <span className="mono dim2">{short(r.signerAddress)}</span>}</td>
              <td className="mono">{r.label.replace('place ', 'Book.place ')}{r.orderId ? <span className="dim">{` · #${r.orderId}`}</span> : null}{r.error ? <span className="tag red" title={r.error} style={{ marginLeft: 8 }}>rejected</span> : null}</td>
              <td className="r">{r.error ? <span className="dim">—</span> : r.path === 'l1' ? <span className="dim2">none · mined only</span> : <span className={`lat ${lat !== undefined && lat >= 100 ? 'slow' : ''}`}><i style={{ width: `${Math.max(2, ((lat ?? 0) / scale) * 90)}px` }} /><b className="mono">{`${ms0(lat)} ms`}</b></span>}</td>
              <td className="r mono dim2">{r.tCommitted !== undefined ? `block ${r.committedBlock}` : r.error ? '—' : 'pending'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Wallet({ session, setSession, request, onClose, records }: { session: PasskeySession | null; setSession: (s: PasskeySession | null) => void; request?: Req; onClose: () => void; records: WriteRecord[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<Array<{ at: number; orderId: string | null; preconfMs: number | null; signMs: number; totalMs: number; error: string | null; label: string }>>([]);
  const [price, setPrice] = useState('100');
  const [qty, setQty] = useState('1');
  const [side, setSide] = useState(0);
  const remembered = rememberedCredential();
  const mine = session ? records.filter((r) => r.signerAddress?.toLowerCase() === session.address.toLowerCase()) : [];
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setErr(null);
    try { await fn(); } catch (e) { setErr(String((e as Error).message ?? e)); } finally { setBusy(null); }
  };
  const sendOrder = () => run('signing', async () => {
    if (!session || !request) return;
    const t0 = performance.now();
    const label = `${side === 0 ? 'Buy' : 'Sell'} ${qty} @ ${price}`;
    const prep = await request<{ prepId: string; hash: `0x${string}` }>({ type: 'prepare', side, price, qty }, 'prepared');
    const tSign = performance.now();
    const signature = await signInjectedHash(session, prep.hash);
    const signMs = performance.now() - tSign;
    const res = await request<{ orderId: string | null; preconfMs: number | null; error: string | null }>({ type: 'submitSigned', prepId: prep.prepId, signature, address: session.address }, 'submitted');
    setSubmitted((s) => [{ at: Date.now(), ...res, signMs, totalMs: performance.now() - t0, label }, ...s].slice(0, 8));
  });
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="drawer">
        <div className="head"><b>Wallet</b><button className="btn line" onClick={onClose}>Close</button></div>
        {!passkeysSupported() ? <p className="note">This browser does not support WebAuthn.</p> : !session ? (
          <div>
            <div className="kv2"><div><div className="k">Status</div><div className="v">Signed out</div></div><div><div className="k">Signing method</div><div className="v">Passkey (WebAuthn PRF → secp256k1)</div></div></div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn" disabled={busy !== null} onClick={() => run('creating', async () => setSession(await createPasskey()))}>Create passkey</button>
              <button className="btn line" disabled={busy !== null} onClick={() => run('signing in', async () => setSession(await signInWithPasskey(remembered)))}>{remembered ? 'Use saved passkey' : 'Sign in'}</button>
            </div>
            <p className="note">The authenticator releases the passkey's PRF secret after user verification. HKDF derives a secp256k1 signing key from it in this browser; the key is never stored or transmitted. The validator recovers the account address from each signature. Injected transactions require no balance: execution is paid from the program's executable balance.</p>
          </div>
        ) : (
          <div>
            <div className="kv2">
              <div><div className="k">Status</div><div className="v">Signed in</div></div>
              <div><div className="k">Signing method</div><div className="v"><span className="tag mint">Passkey</span></div></div>
              <div style={{ gridColumn: 'span 2' }}><div className="k">Account</div><div className="v">{session.address}</div></div>
              <div><div className="k">Transactions from this account</div><div className="v">{mine.length}</div></div>
              <div><div className="k">Best pre-confirmation</div><div className="v big">{(() => { const m = mine.map(preconfOf).filter((x): x is number => x !== undefined); return m.length ? `${Math.min(...m).toFixed(1)} ms` : '—'; })()}</div></div>
            </div>
            <div className="form">
              <div><label>Side</label><select value={side} onChange={(e) => setSide(Number(e.target.value))}><option value={0}>Buy</option><option value={1}>Sell</option></select></div>
              <div><label>Price</label><input value={price} onChange={(e) => setPrice(e.target.value)} /></div>
              <div><label>Quantity</label><input value={qty} onChange={(e) => setQty(e.target.value)} /></div>
              <div><button className="btn" disabled={busy !== null} onClick={sendOrder}>{busy === 'signing' ? 'Signing…' : 'Submit'}</button></div>
            </div>
            <div style={{ marginTop: 12 }}><button className="btn line" onClick={() => { forgetPasskey(); setSession(null); }}>Sign out</button></div>
            <div className="sub">
              <div className="k" style={{ color: 'var(--ink2)', fontSize: 10.5, letterSpacing: '.12em', textTransform: 'uppercase' }}>Submitted transactions</div>
              {submitted.length === 0 && <div className="row dim">None yet.</div>}
              {submitted.map((s) => (
                <div className="row" key={s.at}>
                  <div>{s.label}{s.orderId ? <span className="dim">{` · order #${s.orderId}`}</span> : null}<span className="dim mono" style={{ float: 'right' }}>{clock(s.at)}</span></div>
                  <div>{s.error ? <span className="tag red">{s.error.slice(0, 60)}</span> : <span className="big">{`Pre-confirmed in ${ms0(s.preconfMs)} ms`}</span>}<span className="dim">{` · signed locally in ${s.signMs.toFixed(1)} ms · ${s.totalMs.toFixed(0)} ms end to end from this browser`}</span></div>
                </div>
              ))}
            </div>
          </div>
        )}
        {busy && busy !== 'signing' && <p className="note">{busy}…</p>}
        {err && <p className="note" style={{ color: 'var(--red)' }}>{err}</p>}
      </div>
    </>
  );
}

function Stress({ send, snap, safeDepth }: { send: (cmd: object) => void; snap: Snapshot; safeDepth: number }) {
  const [depth, setDepth] = useState(1);
  const [price, setPrice] = useState('100');
  const [qty, setQty] = useState('1');
  const [side, setSide] = useState(0);
  const dangerous = depth > safeDepth;
  return (
    <div>
      <div className="toolbar" style={{ marginTop: 0 }}>
        <b>Ethereum transaction</b>
        <select value={side} onChange={(e) => setSide(Number(e.target.value))} style={{ background: 'var(--bg)', color: 'var(--ink)', border: '1px solid var(--rule2)', padding: '5px 8px', font: 'inherit' }}><option value={0}>Buy</option><option value={1}>Sell</option></select>
        <input value={price} onChange={(e) => setPrice(e.target.value)} /><input value={qty} onChange={(e) => setQty(e.target.value)} />
        <button className="btn line" onClick={() => send({ type: 'place', path: 'l1', side, price, qty })}>Submit via Mirror.sendMessage</button>
        <span>Pays gas; must be mined before execution; no pre-confirmation exists on this path.</span>
      </div>
      <div className="toolbar">
        <b>Forced reorganisation</b>
        <input type="number" min={1} max={50} value={depth} onChange={(e) => setDepth(Number(e.target.value))} /><span>blocks</span>
        <button className={`btn ${dangerous ? 'red' : 'line'}`} onClick={() => send({ type: 'reorg', depth })}>Execute</button>
        {dangerous ? <span className="tag red">{`Deeper than the validator anchor (${safeDepth}); commitments will halt`}</span> : <span className="tag mint">{`Within the validator anchor (${safeDepth}); expected to be absorbed`}</span>}
      </div>
      <h2 style={{ marginTop: 16 }}>Program state, two sources <span className="r">highlighted rows exist in one view only</span></h2>
      <div className="grid2" style={{ marginTop: 0 }}>
        <Book title="Validator · pre-confirmed" view={snap.preconf} other={snap.committed} />
        <Book title="Ethereum · settled" view={snap.committed} other={snap.preconf} />
      </div>
    </div>
  );
}

function Book({ title, view, other }: { title: string; view: BookView; other: BookView }) {
  const keys = new Set([...other.bids, ...other.asks].map((o) => `${o.id}:${o.qty}`));
  const rows = (orders: Order[], color: string) => orders.length === 0 ? <tr><td className="dim" colSpan={3}>empty</td></tr> : orders.slice(0, 6).map((o) => <tr key={o.id} className={keys.has(`${o.id}:${o.qty}`) ? '' : 'mine'}><td className="mono" style={{ color }}>#{o.id}</td><td className="r mono" style={{ color }}>{o.price}</td><td className="r mono">{o.qty}</td></tr>);
  return (
    <div>
      <div className="dim2" style={{ marginBottom: 6 }}>{`${title} · event sequence ${view.seq}`}</div>
      <div className="grid2" style={{ gap: 12, marginTop: 0 }}>
        <table><thead><tr><th>Bid</th><th className="r">Price</th><th className="r">Qty</th></tr></thead><tbody>{rows(view.bids, 'var(--mint)')}</tbody></table>
        <table><thead><tr><th>Ask</th><th className="r">Price</th><th className="r">Qty</th></tr></thead><tbody>{rows(view.asks, 'var(--red)')}</tbody></table>
      </div>
    </div>
  );
}
