/**
 * The pilot's identity: an Ed25519 key pair that lives in this browser. There are no accounts;
 * whoever holds the secret key is the pilot, so it can be exported for backup and imported again.
 */
import { generateKeyPair, idFromPublicKey, publicKeyOf, type KeyPair } from '@primacy2/shared';

export const IDENTITY_KEY = 'primacy2.identity';

/** The part of `Storage` the identity needs; tests pass an in-memory implementation. */
export interface KeyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface Identity {
  /** Player id derived from the public key. */
  readonly id: string;
  readonly keys: KeyPair;
  /** Secret key as 64 hex digits. */
  exportKey(): string;
  /** Replaces the identity. Returns false (and changes nothing) when the text is not a valid secret key. */
  importKey(text: string): boolean;
}

/** Parses a secret key as exported by `exportKey`; surrounding whitespace and upper case are accepted. */
export function parseSecretKey(text: unknown): KeyPair | null {
  if (typeof text !== 'string') return null;
  const secretKey = text.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(secretKey)) return null;
  try {
    return { secretKey, publicKey: publicKeyOf(secretKey) };
  } catch {
    return null;
  }
}

/** `localStorage`, or null where it is unavailable (private mode, Node). */
export function browserStorage(): KeyStorage | null {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    // Some browsers expose the object but throw on access.
    s.getItem(IDENTITY_KEY);
    return s;
  } catch {
    return null;
  }
}

/**
 * Loads the identity from `storage`, creating and saving a new key pair when there is none or the
 * stored value is damaged. Without storage the identity lasts for the session only.
 */
export function createIdentity(storage: KeyStorage | null): Identity {
  const save = (k: KeyPair): void => {
    try {
      storage?.setItem(IDENTITY_KEY, k.secretKey);
    } catch {
      // Storage is full or blocked; the key then lasts for the session only.
    }
  };
  let stored: string | null = null;
  try {
    stored = storage?.getItem(IDENTITY_KEY) ?? null;
  } catch {
    stored = null;
  }
  let keys = parseSecretKey(stored);
  if (!keys) {
    keys = generateKeyPair();
    save(keys);
  }
  let id = idFromPublicKey(keys.publicKey);
  return {
    get id() {
      return id;
    },
    get keys() {
      return keys!;
    },
    exportKey: () => keys!.secretKey,
    importKey(text: string): boolean {
      const next = parseSecretKey(text);
      if (!next) return false;
      keys = next;
      id = idFromPublicKey(next.publicKey);
      save(next);
      return true;
    },
  };
}
