// Lab configuration: all values come from the running local stack (run/*.addr) and the built IDL.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Address } from 'viem';

const here = dirname(fileURLToPath(import.meta.url));
export const LAB_ROOT = resolve(here, '..', '..');

export const ETH_RPC_HTTP = process.env.ETH_RPC_HTTP ?? 'http://127.0.0.1:8545';
export const ETH_RPC_WS = process.env.ETH_RPC_WS ?? 'ws://127.0.0.1:8545';
/** Read at connect time so the server can route engines through the network emulator. */
export const varaEthRpcWs = () => process.env.VARA_ETH_RPC_WS ?? 'ws://127.0.0.1:9944';
export const VARA_ETH_RPC_DIRECT = 'ws://127.0.0.1:9944';
export const CHAIN_ID = 31337;

export const IDL_PATH = resolve(LAB_ROOT, 'orderbook/target/wasm32-gear/release/orderbook.idl');
export const WASM_PATH = resolve(LAB_ROOT, 'orderbook/target/wasm32-gear/release/orderbook.opt.wasm');

/** Anvil's default mnemonic; the ethexe dev node spawns Anvil with it (12 accounts). */
export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
/** Account index layout from `ethexe_service::configure_dev_environment`: 0 deployer, 1 validator, 2.. senders. */
export const FIRST_SENDER_INDEX = 2;

function readAddr(name: string): Address {
  return readFileSync(resolve(LAB_ROOT, 'run', name), 'utf8').trim() as Address;
}

export function routerAddress(): Address {
  return readAddr('router.addr');
}

export function mirrorAddress(): Address {
  return readAddr('mirror.addr');
}

export interface NodeSettings {
  quarantine: number;
  blockTime: number;
  startedAt: string;
}

/** Settings the node was started with (written by run/start-node.sh); defaults if the file is missing. */
export function nodeSettings(): NodeSettings {
  try {
    return JSON.parse(readFileSync(resolve(LAB_ROOT, 'run', 'node.json'), 'utf8')) as NodeSettings;
  } catch {
    return { quarantine: 0, blockTime: 1, startedAt: '' };
  }
}
