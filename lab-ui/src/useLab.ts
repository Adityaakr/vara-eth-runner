import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from './types';

const WS_URL = (import.meta.env?.VITE_LAB_WS as string | undefined) ?? 'ws://127.0.0.1:8787';

export function useLab() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [lastError, setLastError] = useState<string | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const waiters = useRef<Array<(msg: Record<string, unknown>) => boolean>>([]);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const sock = new WebSocket(WS_URL);
      ws.current = sock;
      sock.onopen = () => setStatus('open');
      sock.onclose = () => {
        setStatus('closed');
        if (!closed) retry = setTimeout(connect, 1000);
      };
      sock.onmessage = (ev) => {
        let msg: { type: string; message?: string };
        try {
          msg = JSON.parse(ev.data as string);
        } catch {
          return;
        }
        if (msg.type === 'snapshot') setSnap(msg as Snapshot);
        else if (msg.type === 'error') setLastError(msg.message as string);
        waiters.current = waiters.current.filter((w) => !w(msg as Record<string, unknown>));
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws.current?.close();
    };
  }, []);

  const send = (cmd: object) => ws.current?.send(JSON.stringify(cmd));
  /** Send a command and resolve with the first reply whose `type` matches (or reject on an error). */
  const request = <T,>(cmd: object, replyType: string, timeoutMs = 30_000) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for ' + replyType)), timeoutMs);
      waiters.current.push((msg) => {
        if (msg.type === replyType) {
          clearTimeout(timer);
          resolve(msg as T);
          return true;
        }
        if (msg.type === 'error') {
          clearTimeout(timer);
          reject(new Error(String(msg.message)));
          return true;
        }
        return false;
      });
      send(cmd);
    });
  return { snap, status, lastError, send, request };
}
