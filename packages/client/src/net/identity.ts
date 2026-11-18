/**
 * The pilot's identity: an Ed25519 key pair kept in this browser. There is no account on any
 * server; whoever holds the secret key is the pilot.
 */
import { generateKeyPair, publicKeyOf, type KeyPair } from '@primacy2/shared';

const STORAGE_KEY = 'primacy2.identity';

function save(keys: KeyPair): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ secretKey: keys.secretKey }));
  } catch {
    // Without storage the identity lasts for this page load only.
  }
}

/** Loads the stored identity, creating and storing a new one on first use. */
export function loadIdentity(): KeyPair {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { secretKey?: unknown };
      if (typeof parsed.secretKey === 'string') {
        return { secretKey: parsed.secretKey, publicKey: publicKeyOf(parsed.secretKey) };
      }
    }
  } catch {
    // A corrupt entry is replaced below.
  }
  const fresh = generateKeyPair();
  save(fresh);
  return fresh;
}

/** Replaces the stored identity with a secret key given as 64 hex digits. Returns null when it is not valid. */
export function importIdentity(text: string): KeyPair | null {
  const hex = text.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  try {
    const keys = { secretKey: hex, publicKey: publicKeyOf(hex) };
    save(keys);
    return keys;
  } catch {
    return null;
  }
}
