// Connections to the local stack: viem for Anvil, @vara-eth/api for the ethexe validator RPC.
import { createVaraEthApi, getMirrorClient, WsVaraEthProvider, type VaraEthApi, type MirrorClient } from '@vara-eth/api';
import { privateKeyToLocalSigner } from '@vara-eth/api/signer';
import { createPublicClient, createWalletClient, defineChain, http, toHex, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { ANVIL_MNEMONIC, CHAIN_ID, ETH_RPC_HTTP, FIRST_SENDER_INDEX, varaEthRpcWs, mirrorAddress, routerAddress } from './config.js';

const anvilChain = defineChain({ id: CHAIN_ID, name: 'anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [ETH_RPC_HTTP] } } });

export interface Sender {
  readonly index: number;
  readonly address: Address;
  readonly privateKey: Hex;
}

/** Deterministic Anvil account for the n-th lab sender (0-based). */
export function senderAccount(n = 0): Sender {
  const index = FIRST_SENDER_INDEX + n;
  const account = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index });
  const privateKey = account.getHdKey().privateKey;
  if (!privateKey) throw new Error('HD key has no private key');
  return { index, address: account.address, privateKey: toHex(privateKey) };
}

export interface Chain {
  readonly api: VaraEthApi;
  readonly publicClient: PublicClient;
  /** viem wallet for the sender; used to sign L1 transactions before the measured window. */
  readonly wallet: WalletClient;
  readonly mirror: MirrorClient;
  readonly mirrorAddress: Address;
  readonly routerAddress: Address;
  readonly sender: Sender;
  disconnect(): Promise<void>;
}

export async function connectChain(senderIndex = 0, mirrorOverride?: Address): Promise<Chain> {
  const sender = senderAccount(senderIndex);
  // Anvil mines every second; viem's default 4 s receipt polling would dominate L1 timings.
  const publicClient = createPublicClient({ chain: anvilChain, transport: http(ETH_RPC_HTTP), pollingInterval: 50 });
  const wallet = createWalletClient({ account: privateKeyToAccount(sender.privateKey), chain: anvilChain, transport: http(ETH_RPC_HTTP) });
  const signer = privateKeyToLocalSigner(sender.privateKey, publicClient);
  const provider = new WsVaraEthProvider(varaEthRpcWs());
  const router = routerAddress();
  const api = await createVaraEthApi(provider, publicClient, router, signer);
  const mirrorAddr = mirrorOverride ?? mirrorAddress();
  const mirror = getMirrorClient({ address: mirrorAddr, publicClient, signer });
  return {
    api,
    publicClient,
    wallet,
    mirror,
    mirrorAddress: mirrorAddr,
    routerAddress: router,
    sender,
    disconnect: () => provider.disconnect(),
  };
}
