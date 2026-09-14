// Passkey signing. A validator verifies secp256k1 signatures and recovers an Ethereum address,
// which a WebAuthn P-256 credential cannot produce directly. So the passkey's PRF extension
// (a per-credential deterministic secret, released only after user verification) seeds a
// secp256k1 key via HKDF. The key never leaves the browser; the server only relays signatures.
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { toHex, type Hex } from 'viem';

const RP_NAME = 'Vara.eth preconf lab';
const PRF_SALT = new TextEncoder().encode('vara-eth-preconf-lab/secp256k1/v1');
const STORAGE_KEY = 'preconf-lab.passkey.credentialId';

export interface PasskeySession {
  readonly account: PrivateKeyAccount;
  readonly address: Hex;
  readonly credentialId: string;
}

export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && 'PublicKeyCredential' in window && !!navigator.credentials;
}

export function rememberedCredential(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function b64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(b.length));
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

async function deriveAccount(prf: ArrayBuffer): Promise<PrivateKeyAccount> {
  const key = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: PRF_SALT, info: new TextEncoder().encode('secp256k1 signing key') }, key, 256);
  return privateKeyToAccount(toHex(new Uint8Array(bits)));
}

function prfOutput(cred: PublicKeyCredential): ArrayBuffer {
  const ext = cred.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } };
  const first = ext.prf?.results?.first;
  if (!first) throw new Error('This passkey or browser did not return a PRF secret. Use Chrome 116+ or Safari 18+ with a platform passkey (Touch ID / iCloud Keychain).');
  return first;
}

/** Create a new passkey and derive its signing account. */
export async function createPasskey(): Promise<PasskeySession> {
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: RP_NAME, id: location.hostname },
      user: { id: userId, name: `trader-${b64url(userId.buffer).slice(0, 6)}`, displayName: 'Vara.eth lab trader' },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('passkey creation was cancelled');
  const credentialId = b64url(cred.rawId);
  // Some authenticators only evaluate PRF during assertion; sign in right away to get the secret.
  let prf: ArrayBuffer;
  try {
    prf = prfOutput(cred);
  } catch {
    return signInWithPasskey(credentialId);
  }
  localStorage.setItem(STORAGE_KEY, credentialId);
  const account = await deriveAccount(prf);
  return { account, address: account.address, credentialId };
}

/** Sign in with an existing passkey (any resident passkey for this origin if no id is given). */
export async function signInWithPasskey(credentialId?: string | null): Promise<PasskeySession> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      rpId: location.hostname,
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      userVerification: 'required',
      allowCredentials: credentialId ? [{ type: 'public-key', id: fromB64url(credentialId) }] : [],
      extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('passkey sign-in was cancelled');
  const id = b64url(cred.rawId);
  localStorage.setItem(STORAGE_KEY, id);
  const account = await deriveAccount(prfOutput(cred));
  return { account, address: account.address, credentialId: id };
}

/** EIP-191 signature over the 32-byte injected-transaction hash, exactly what the validator recovers. */
export async function signInjectedHash(session: PasskeySession, hash: Hex): Promise<Hex> {
  return session.account.signMessage({ message: { raw: hash } });
}

export function forgetPasskey(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
