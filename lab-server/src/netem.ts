// Network-condition emulator: a WebSocket proxy in front of the validator RPC that delays every
// frame, in both directions, by a one-way latency plus jitter and occasional spikes. Delays are
// order-preserving. The point is to put the real wire back into a loopback measurement: on the
// live network the round trip to the validator dominates pre-confirmation time.
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { performance } from 'node:perf_hooks';

export interface NetProfile {
  readonly name: 'local' | 'measured' | 'global';
  /** One-way delay applied in each direction, ms. */
  readonly oneWayMs: number;
  /** Standard deviation of per-frame jitter, ms. */
  readonly jitterMs: number;
  /** Probability that a frame gets an extra spike (retransmit-like), and its size. */
  readonly spikeP: number;
  readonly spikeMs: number;
  readonly note: string;
}

export interface Calibration {
  readonly target: string;
  readonly rttMs: number | null;
}

export function profiles(cal: Calibration): Record<NetProfile['name'], NetProfile> {
  const rtt = cal.rttMs ?? 160;
  return {
    local: { name: 'local', oneWayMs: 0, jitterMs: 0, spikeP: 0, spikeMs: 0, note: 'loopback, no emulation' },
    measured: { name: 'measured', oneWayMs: rtt / 2, jitterMs: 4, spikeP: 0.02, spikeMs: 60, note: `calibrated: ${rtt.toFixed(0)} ms round trip to ${cal.target}` },
    global: { name: 'global', oneWayMs: 120, jitterMs: 8, spikeP: 0.03, spikeMs: 90, note: 'cross-continent, 240 ms round trip' },
  };
}

/** Median WebSocket JSON-RPC round trip to a live endpoint; null on failure. */
export async function calibrate(url: string, method: string, samples = 7, timeoutMs = 10_000): Promise<Calibration> {
  const target = url.replace(/^wss?:\/\//, '');
  const rttMs = await new Promise<number | null>((resolve) => {
    const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
    const got: number[] = [];
    let sentAt = 0;
    const timer = setTimeout(() => { ws.terminate(); resolve(null); }, timeoutMs);
    const ping = () => { sentAt = performance.now(); ws.send(JSON.stringify({ jsonrpc: '2.0', id: got.length + 1, method, params: [] })); };
    ws.on('open', ping);
    ws.on('message', () => {
      got.push(performance.now() - sentAt);
      if (got.length < samples) ping();
      else { clearTimeout(timer); ws.close(); const s = [...got].sort((a, b) => a - b); resolve(s[Math.floor(s.length / 2)]); }
    });
    ws.on('error', () => { clearTimeout(timer); resolve(null); });
  });
  return { target, rttMs };
}

function gaussian(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class NetEmulator {
  profile: NetProfile;
  /** Frame counters for debugging (`LAB_NETEM_DEBUG=1` prints them every second). */
  readonly counters = { up: 0, down: 0, upSent: 0, downSent: 0, conns: 0, upErrors: 0 };
  private server?: WebSocketServer;
  constructor(private readonly upstream: string, initial: NetProfile) {
    this.profile = initial;
  }

  private delay(): number {
    const p = this.profile;
    if (p.oneWayMs === 0) return 0;
    const spike = Math.random() < p.spikeP ? p.spikeMs * (0.5 + Math.random()) : 0;
    return Math.max(0, p.oneWayMs + gaussian() * p.jitterMs + spike);
  }

  listen(port: number): void {
    this.server = new WebSocketServer({ host: '127.0.0.1', port });
    if (process.env.LAB_NETEM_DEBUG) setInterval(() => console.error('[netem]', JSON.stringify(this.counters)), 1000);
    this.server.on('connection', (client) => {
      this.counters.conns++;
      const up = new WebSocket(this.upstream);
      up.on('error', (e) => { this.counters.upErrors++; console.error('[netem] upstream error', e.message); });
      const pending: Array<{ data: Buffer; binary: boolean }> = [];
      let lastToUp = 0;
      let lastToClient = 0;
      // `ws` may hand out a slice of its internal receive buffer; it is overwritten by later frames,
      // so a delayed forward must copy the bytes first or bursts corrupt in-flight messages.
      const send = (dst: WebSocket, raw: RawData, binary: boolean, dir: 'up' | 'down') => {
        const data = Array.isArray(raw) ? Buffer.concat(raw.map((b) => Buffer.from(b))) : Buffer.from(raw as Buffer);
        const now = performance.now();
        const at = Math.max(now + this.delay(), dir === 'up' ? lastToUp : lastToClient); // never reorder
        if (dir === 'up') lastToUp = at; else lastToClient = at;
        if (dir === 'up') this.counters.up++; else this.counters.down++;
        setTimeout(() => {
          if (dst.readyState === dst.OPEN) {
            dst.send(data, { binary }, (err) => { if (err) this.counters.upErrors++; });
            if (dir === 'up') this.counters.upSent++; else this.counters.downSent++;
          }
        }, at - now);
      };
      up.on('open', () => { for (const m of pending) send(up, m.data, m.binary, 'up'); pending.length = 0; });
      client.on('message', (data, binary) => (up.readyState === up.OPEN ? send(up, data, binary, 'up') : pending.push({ data: Array.isArray(data) ? Buffer.concat(data.map((b) => Buffer.from(b))) : Buffer.from(data as Buffer), binary })));
      up.on('message', (data, binary) => send(client, data, binary, 'down'));
      client.on('close', () => up.close());
      up.on('close', () => client.close());
      up.on('error', () => client.close());
      client.on('error', () => up.close());
    });
  }

  close(): void {
    this.server?.close();
  }
}
