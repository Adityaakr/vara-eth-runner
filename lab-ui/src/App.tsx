import { useEffect, useRef, useState } from 'react';
import { useLab } from './useLab';
import { createPasskey, forgetPasskey, passkeysSupported, rememberedCredential, signInWithPasskey, signInjectedHash, type PasskeySession } from './passkey';
import type { Snapshot, WriteRecord } from './types';

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
        <div className="mast"><div className="mark"><img src="/vara-eth-logo.svg" alt="Vara.eth" />VARA.ETH <span>Executed before the next block · settled by Ethereum · measured, not promised</span></div><div className="meta"><span className="chip off"><i />{lab.status === 'open' ? 'connecting' : 'server offline'}</span></div></div>
        <div className="page"><p className="note">Start the telemetry server: <code>cd lab-server && npm run serve</code></p></div>
      </div>
    );
  }
  return <LabView snap={lab.snap} lastError={lab.lastError} send={lab.send} request={lab.request} />;
}

/** Pure view of one snapshot; also rendered server-side by scripts/render-check.tsx. */
export function LabView({ snap, lastError, send, request }: { snap: Snapshot; lastError: string | null; send: (cmd: object) => void; request?: Req }) {
  const [wallet, setWallet] = useState(false);
  const [controls, setControls] = useState(false);
  const [session, setSession] = useState<PasskeySession | null>(null);
  const stuck = snap.records.filter((r) => !r.error && r.tCommitted === undefined && snap.now - r.submittedAt > STUCK_AFTER_MS).length;
  const pre = snap.latency.preconf;
  const safeDepth = snap.node.quarantine + 1;
  const gap = Number(snap.preconf.seq) - Number(snap.committed.seq);
  return (
    <div>
      <div className="mast">
        <div className="mark"><img src="/vara-eth-logo.svg" alt="Vara.eth" />VARA.ETH <span>Executed before the next block · settled by Ethereum · measured, not promised</span></div>
        <div className="meta">
          <button className="btn line" onClick={() => setControls(true)}>Controls</button>
          <button className="btn" onClick={() => setWallet(true)}>{session ? `Wallet · ${session.address.slice(0, 6)}…${session.address.slice(-4)}` : 'Wallet'}</button>
        </div>
      </div>
      <div className="page">
        {lastError && <div className="alert">Command rejected · {lastError}</div>}
        {snap.preconfError && !snap.validator.recycling && <div className="alert">The validator is not answering state queries · {snap.preconfError}</div>}
        {snap.validator.recycling && <div className="alert" style={{ borderColor: 'var(--mint)', background: 'color-mix(in srgb, var(--mint) 8%, transparent)' }}>Recycling the validator. Traffic resumes in about 20 s.</div>}
        {stuck > 0 && !snap.validator.recycling && <div className="alert">{`${stuck} pre-confirmed transaction${stuck > 1 ? 's have' : ' has'} not settled on Ethereum for over ${STUCK_AFTER_MS / 1000} s. The validator continues to pre-confirm but is no longer committing, the signature of a reorg deeper than its anchor. Restart with run/start-node.sh.`}</div>}

        <Band snap={snap} />

        <div className="tiles">
          <div className="tile"><div className="k">Latest height</div><div className="v">{snap.ethHead}</div></div>
          <div className="tile"><div className="k">Median pre-confirm</div><div className="v mint">{ms0(pre?.p50)}<u>ms</u></div><div className="s">{pre ? `n ${n(pre.count)}` : '—'}</div></div>
          <div className="tile"><div className="k">P95</div><div className="v">{ms0(pre?.p95)}<u>ms</u></div><div className="s">{pre ? `max ${ms0(pre.max)}` : '—'}</div></div>
          <div className="tile"><div className="k">Fastest</div><div className="v mint">{ms0(snap.totals.allTimeMinMs, 1)}<u>ms</u></div><div className="s">since start</div></div>
          <div className="tile"><div className="k">Pre-confirmed txs</div><div className="v">{n(snap.totals.preconfirmed)}</div><div className="s">since start</div></div>
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

        <p className="note dim">{`Program instance ${snap.mirror} · single local validator on one machine; figures are measured, not quoted.`}</p>
      </div>
      {wallet && <Wallet session={session} setSession={setSession} request={request} onClose={() => setWallet(false)} records={snap.records} ledger={snap.ledger} />}
      {controls && (
        <>
          <div className="scrim" onClick={() => setControls(false)} />
          <div className="drawer">
            <div className="head"><b>Controls</b><button className="btn line" onClick={() => setControls(false)}>Close</button></div>
            <Toolbar send={send} snap={snap} />
            <p className="note">Network: every frame to and from the validator is delayed by a one-way latency; the measured profile is calibrated live. Traffic: the autopilot keeps a steady rate across four program instances with periodic surges. Load test: a burst with the given number in flight, run in its own process.</p>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Dense throughput band: half-second buckets, lightly smoothed, gapless layered bars that glide
 * continuously. Scaled to the 98th percentile so steady traffic sits high with a live, textured crest.
 */
function Band({ snap }: { snap: Snapshot }) {
  const { start, stepMs, counts } = snap.fine;
  const [now, setNow] = useState(snap.now);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let raf = 0;
    const loop = () => { setNow(Date.now()); raf = window.requestAnimationFrame(loop); };
    raf = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(raf);
  }, []);
  // Light smoothing (3-bucket weighted average) keeps the crest textured without single-bucket spikes.
  const smoothed = counts.map((c, i) => (0.25 * (counts[i - 1] ?? c) + 0.5 * c + 0.25 * (counts[i + 1] ?? c)));
  const sorted = [...smoothed].sort((a, b) => a - b);
  const p98 = sorted[Math.floor(sorted.length * 0.98)] ?? 0;
  const maxV = Math.max(3, p98 * 1.08);
  const n0 = counts.length;
  const barW = 100 / n0;
  // The last bucket is still filling; the strip shifts left by the elapsed fraction of it.
  const elapsed = Math.min(1, Math.max(0, (now - (start + (n0 - 1) * stepMs)) / stepMs));
  return (
    <div className="band">
      <div className="band-clip">
        <div className="band-strip" style={{ width: `${100 + barW}%`, transform: `translateX(${-elapsed * barW}%)` }}>
          {smoothed.map((v, i) => <div key={start + i * stepMs} className="bar" style={{ height: `${Math.min(1, v / maxV) * 100}%` }} />)}
          <div className="bar ghost" />
        </div>
      </div>
    </div>
  );
}

function Toolbar({ send, snap }: { send: (cmd: object) => void; snap: Snapshot }) {
  const [rate, setRate] = useState(String(snap.autopilot.rate || 12));
  const [burst, setBurst] = useState('1000');
  const [conc, setConc] = useState('64');
  const last = snap.blast.last;
  return (
    <div className="toolbar">
      <div className="group">
        <div className="lbl">Network</div>
        <div className="row">
          <select value={snap.network.profile} onChange={(e) => send({ type: 'network', profile: e.target.value })}>
            {snap.network.profiles.map((p) => <option key={p.name} value={p.name}>{p.name === 'local' ? 'Loopback' : p.name === 'measured' ? `Measured · ${(p.oneWayMs * 2).toFixed(0)} ms RTT` : `Global · ${(p.oneWayMs * 2).toFixed(0)} ms RTT`}</option>)}
          </select>
          <span className="cap" title={snap.network.note}>{snap.network.calibration.rttMs ? `live: ${snap.network.calibration.target}` : 'default 160 ms'}</span>
        </div>
      </div>
      <div className="group">
        <div className="lbl">Traffic</div>
        <div className="row">
          <input value={rate} onChange={(e) => setRate(e.target.value)} /><span className="cap">tx/s</span>
          <button className="btn line" onClick={() => send({ type: 'autopilot', rate: Number(rate) })}>Apply</button>
          <button className="btn line" disabled={!snap.autopilot.running} onClick={() => send({ type: 'autopilot', rate: 0 })}>Pause</button>
          <button className="btn line" disabled={snap.validator.recycling} onClick={() => send({ type: 'recycle' })}>{snap.validator.recycling ? 'Recycling…' : 'Recycle'}</button>
          <span className="cap">{snap.autopilot.running ? `${snap.autopilot.rate} tx/s · surges` : 'paused'}</span>
        </div>
      </div>
      <div className="group">
        <div className="lbl">Load test</div>
        <div className="row">
          <input value={burst} onChange={(e) => setBurst(e.target.value)} /><span className="cap">txs</span>
          <input value={conc} onChange={(e) => setConc(e.target.value)} /><span className="cap">in flight</span>
          <button className="btn" disabled={snap.blast.running} onClick={() => send({ type: 'blast', total: Number(burst), concurrency: Number(conc) })}>{snap.blast.running ? 'Running…' : 'Run'}</button>
          {last && !snap.blast.running && <span className="cap">{`${last.preconfPerSec.toFixed(0)} tx/s · ${n(last.ok)}/${n(last.total)}`}</span>}
        </div>
      </div>
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
      <thead><tr><th>Time</th><th>Transaction</th><th>Account</th><th>Call</th><th className="r">Pre-confirmation</th></tr></thead>
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
              <td className="mono">{r.label.startsWith('cancel') ? `Book.${r.label}` : r.label.startsWith('transfer') || r.label === 'faucet' ? `Ledger.${r.label}` : r.label.replace('place ', 'Book.place ')}{r.orderId && !r.label.startsWith('cancel') && !r.label.startsWith('transfer') && r.label !== 'faucet' ? <span className="dim">{` · #${r.orderId}`}</span> : null}{r.error ? <span className="tag red" title={r.error} style={{ marginLeft: 8 }}>rejected</span> : null}</td>
              <td className="r">{r.error ? <span className="dim">—</span> : r.path === 'l1' ? <span className="dim2">none · mined only</span> : <span className={`lat ${lat !== undefined && lat >= 100 ? 'slow' : ''}`}><i style={{ width: `${Math.max(2, ((lat ?? 0) / scale) * 90)}px` }} /><b className="mono">{`${ms0(lat)} ms`}</b></span>}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

type Submitted = { at: number; label: string; result: string | null; preconfMs: number | null; signMs: number; totalMs: number; error: string | null };

function Wallet({ session, setSession, request, onClose, records, ledger }: { session: PasskeySession | null; setSession: (s: PasskeySession | null) => void; request?: Req; onClose: () => void; records: WriteRecord[]; ledger: string | null }) {
  const [tab, setTab] = useState<'send' | 'trade'>('send');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<Submitted[]>([]);
  const [balance, setBalance] = useState<string | null>(null);
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('10');
  const [price, setPrice] = useState('100');
  const [qty, setQty] = useState('1');
  const [side, setSide] = useState(0);
  const remembered = rememberedCredential();
  const mine = session ? records.filter((r) => r.signerAddress?.toLowerCase() === session.address.toLowerCase()) : [];
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setErr(null);
    try { await fn(); } catch (e) { setErr(String((e as Error).message ?? e)); } finally { setBusy(null); }
  };
  const refreshBalance = async () => {
    if (!session || !request || !ledger) return;
    const r = await request<{ balance: string }>({ type: 'balance', address: session.address }, 'balance');
    setBalance(r.balance);
  };
  useEffect(() => { void refreshBalance().catch(() => undefined); }, [session?.address]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Prepare on the server, sign the hash here, submit; the server measures submit → signed result. */
  const signAndSend = async (cmd: object, label: string) => {
    if (!session || !request) return;
    const t0 = performance.now();
    const prep = await request<{ prepId: string; hash: `0x${string}` }>(cmd, 'prepared');
    const tSign = performance.now();
    const signature = await signInjectedHash(session, prep.hash);
    const signMs = performance.now() - tSign;
    const res = await request<{ result: string | null; preconfMs: number | null; error: string | null }>({ type: 'submitSigned', prepId: prep.prepId, signature, address: session.address }, 'submitted');
    setSubmitted((s) => [{ at: Date.now(), label, ...res, signMs, totalMs: performance.now() - t0 }, ...s].slice(0, 8));
    return res;
  };
  const send = () => run('signing', async () => {
    const res = await signAndSend({ type: 'prepare', kind: 'transfer', to, amount }, `Send ${amount} → ${to.slice(0, 6)}…${to.slice(-4)}`);
    if (res && !res.error && res.result !== null) setBalance(res.result);
  });
  const faucet = () => run('signing', async () => {
    const res = await signAndSend({ type: 'prepare', kind: 'faucet' }, 'Faucet');
    if (res && !res.error && res.result !== null) setBalance(res.result);
  });
  const trade = () => run('signing', async () => { await signAndSend({ type: 'prepare', kind: 'place', side, price, qty }, `${side === 0 ? 'Buy' : 'Sell'} ${qty} @ ${price}`); });
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
            <p className="note">The authenticator releases the passkey's PRF secret after user verification. HKDF derives a secp256k1 signing key from it in this browser; the key is never stored or transmitted. The validator recovers the account address from each signature. Transactions need no gas balance: execution is paid from the program's executable balance.</p>
          </div>
        ) : (
          <div>
            <div className="kv2">
              <div><div className="k">Status</div><div className="v">Signed in · <span className="tag mint">Passkey</span></div></div>
              <div><div className="k">Balance</div><div className="v big">{balance === null ? '—' : `${Number(balance).toLocaleString()} units`}</div></div>
              <div style={{ gridColumn: 'span 2' }}><div className="k">Account</div><div className="v">{session.address}</div></div>
            </div>
            <div className="tabs">
              <button className={`tab ${tab === 'send' ? 'on' : ''}`} onClick={() => setTab('send')}>Send</button>
              <button className={`tab ${tab === 'trade' ? 'on' : ''}`} onClick={() => setTab('trade')}>Trade</button>
              <span style={{ flex: 1 }} />
              <button className="btn line" onClick={() => void refreshBalance()}>Refresh</button>
              <button className="btn line" onClick={() => { forgetPasskey(); setSession(null); setBalance(null); }}>Sign out</button>
            </div>
            {tab === 'send' ? (
              <div>
                {balance === '0' && <div className="faucet"><span>This account has no balance yet.</span><button className="btn" disabled={busy !== null} onClick={faucet}>{busy === 'signing' ? 'Signing…' : 'Get 1,000 test units'}</button></div>}
                <div className="form send">
                  <div><label>To</label><input value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" spellCheck={false} /></div>
                  <div><label>Amount</label><input value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
                  <div><button className="btn" disabled={busy !== null || !ledger} onClick={send}>{busy === 'signing' ? 'Signing…' : 'Submit'}</button></div>
                </div>
                <p className="note">Signed here with the passkey key, sent straight to the validator, no gas. The result is the validator's signed execution receipt; the balance shown is what it returned.</p>
              </div>
            ) : (
              <div>
                <div className="form">
                  <div><label>Side</label><select value={side} onChange={(e) => setSide(Number(e.target.value))}><option value={0}>Buy</option><option value={1}>Sell</option></select></div>
                  <div><label>Price</label><input value={price} onChange={(e) => setPrice(e.target.value)} /></div>
                  <div><label>Quantity</label><input value={qty} onChange={(e) => setQty(e.target.value)} /></div>
                  <div><button className="btn" disabled={busy !== null} onClick={trade}>{busy === 'signing' ? 'Signing…' : 'Submit'}</button></div>
                </div>
                <p className="note">Places an order on the lab's order book; it will trade against the autopilot's flow if it crosses.</p>
              </div>
            )}
            <div className="sub">
              <div className="k" style={{ color: 'var(--ink2)', fontSize: 10.5, letterSpacing: '.12em', textTransform: 'uppercase' }}>Submitted transactions</div>
              {submitted.length === 0 && <div className="row dim">None yet.{mine.length ? ` ${mine.length} earlier from this account are on the tape.` : ''}</div>}
              {submitted.map((s) => (
                <div className="row" key={s.at}>
                  <div>{s.label}<span className="dim mono" style={{ float: 'right' }}>{clock(s.at)}</span></div>
                  <div>{s.error ? <span className="tag red">{s.error.slice(0, 70)}</span> : <span className="big">{`Pre-confirmed in ${ms0(s.preconfMs)} ms`}</span>}<span className="dim">{` · signed locally in ${s.signMs.toFixed(1)} ms · ${s.totalMs.toFixed(0)} ms end to end${s.result !== null && !s.error && !s.label.startsWith('Buy') && !s.label.startsWith('Sell') ? ` · balance ${Number(s.result).toLocaleString()}` : ''}`}</span></div>
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
