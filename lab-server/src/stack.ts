// Control of the local stack from the lab: restart the node with a quarantine, redeploy, reorg Anvil.
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PublicClient } from 'viem';
import { LAB_ROOT } from './config.js';

const NODE_LOG = resolve(LAB_ROOT, 'run/node.log');

/** Restart the ethexe dev node (fresh Anvil, fresh DB) with the given canonical quarantine. */
export function restartNode(quarantine: number): void {
  execFileSync(resolve(LAB_ROOT, 'run/start-node.sh'), ['--quarantine', String(quarantine)], { stdio: 'inherit', timeout: 120_000 });
}

/** Async variants for the long-running server, so a recycle does not block its event loop. */
export function restartNodeAsync(quarantine: number): Promise<void> {
  return runAsync(resolve(LAB_ROOT, 'run/start-node.sh'), ['--quarantine', String(quarantine)]);
}
export function deployProgramAsync(): Promise<void> {
  return runAsync(resolve(LAB_ROOT, 'run/deploy.sh'), []);
}
function runAsync(file: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    execFile(file, args, { timeout: 180_000 }, (err, _out, stderr) => (err ? rej(new Error(`${file} failed: ${String(stderr).slice(-300)}`)) : res()));
  });
}

/** Upload + create + init the orderbook program; writes run/mirror.addr. */
export function deployProgram(): void {
  execFileSync(resolve(LAB_ROOT, 'run/deploy.sh'), [], { stdio: 'pipe', timeout: 180_000 });
}

/** Force Anvil to drop `depth` blocks and re-mine them empty (Foundry 1.7.0 positional params). */
export async function anvilReorg(client: PublicClient, depth: number): Promise<void> {
  await client.request({ method: 'anvil_reorg' as never, params: [depth, []] as never });
}

/** Count node-log lines saying the coordinator refuses to commit because its chain left canonical Ethereum. */
export function nodeRefusedCommitments(): number {
  const log = readFileSync(NODE_LOG, 'utf8');
  return log.split('\n').filter((l) => l.includes('refusing to build batch')).length;
}

/** Wait for the node to pass its first Malachite height after a restart, so injected txs are accepted. */
export async function waitForNodeReady(client: PublicClient, minBlocks = 3): Promise<void> {
  const start = await client.getBlockNumber();
  while ((await client.getBlockNumber()) < start + BigInt(minBlocks)) {
    await new Promise((r) => setTimeout(r, 200));
  }
}
