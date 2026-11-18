/**
 * Identity and signatures. Works unchanged in browsers and Node.
 *
 * Every signed object is `{ body, key, sig }`. The signature covers a domain tag plus the
 * canonical JSON of `body`, so a signature made for one purpose can never be replayed as another.
 */
import * as ed from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';

// noble-ed25519 needs a synchronous SHA-512 for its sync API.
ed.hashes.sha512 = sha512;

const enc = new TextEncoder();
const HEX = '0123456789abcdef';
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]! >> 4]! + HEX[bytes[i]! & 15]!;
  return s;
}

/** Strict hex decoding: lowercase or uppercase digits only, even length. Returns null on anything else. */
export function fromHex(hex: unknown, expectedBytes?: number): Uint8Array | null {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  if (expectedBytes !== undefined && hex.length !== expectedBytes * 2) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Deterministic JSON: object keys sorted, no whitespace. Rejects values JSON cannot represent
 * faithfully (non-finite numbers, undefined inside arrays, functions) so that two parties always
 * hash identical bytes for an identical value.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']';
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export interface KeyPair {
  /** 32-byte Ed25519 seed, hex. Never leaves its owner. */
  secretKey: string;
  /** 32-byte Ed25519 public key, hex. */
  publicKey: string;
}

export function generateKeyPair(): KeyPair {
  const { secretKey, publicKey } = ed.keygen();
  return { secretKey: toHex(secretKey), publicKey: toHex(publicKey) };
}

export function publicKeyOf(secretKeyHex: string): string {
  const sk = fromHex(secretKeyHex, 32);
  if (!sk) throw new Error('invalid secret key');
  return toHex(ed.getPublicKey(sk));
}

/** 16-character base32 id derived from a public key. Used for both server ids and player ids. */
export function idFromPublicKey(publicKeyHex: string): string {
  const pk = fromHex(publicKeyHex, 32);
  if (!pk) throw new Error('invalid public key');
  return base32(sha256(pk).subarray(0, 10));
}

export const isValidId = (id: unknown): id is string => typeof id === 'string' && /^[a-z2-7]{16}$/.test(id);

export function randomNonce(bytes = 16): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return toHex(b);
}

export function sha256Hex(text: string): string {
  return toHex(sha256(enc.encode(text)));
}

/** Signature domains. A signature is only valid for the domain it was made in. */
export const Domain = {
  Descriptor: 'primacy2/descriptor/v1',
  Ticket: 'primacy2/ticket/v1',
  Auth: 'primacy2/auth/v1',
  Fed: 'primacy2/fed/v1',
  Ledger: 'primacy2/ledger/v1',
} as const;
export type Domain = (typeof Domain)[keyof typeof Domain];

export interface Signed<T> {
  body: T;
  /** Signer's public key, hex. */
  key: string;
  /** Ed25519 signature, hex. */
  sig: string;
}

const message = (domain: string, payload: string): Uint8Array => enc.encode(domain + '\n' + payload);

export function signText(domain: Domain, text: string, secretKeyHex: string): string {
  const sk = fromHex(secretKeyHex, 32);
  if (!sk) throw new Error('invalid secret key');
  return toHex(ed.sign(message(domain, text), sk));
}

/** Never throws; malformed keys or signatures simply fail verification. */
export function verifyText(domain: Domain, text: string, sigHex: unknown, publicKeyHex: unknown): boolean {
  const sig = fromHex(sigHex, 64);
  const pk = fromHex(publicKeyHex, 32);
  if (!sig || !pk) return false;
  try {
    return ed.verify(sig, message(domain, text), pk);
  } catch {
    return false;
  }
}

export function signBody<T>(domain: Domain, body: T, keys: KeyPair): Signed<T> {
  return { body, key: keys.publicKey, sig: signText(domain, canonicalJson(body), keys.secretKey) };
}

/** Checks shape and signature only. Callers must still check what the body claims. */
export function verifySigned<T>(domain: Domain, signed: unknown): signed is Signed<T> {
  if (!signed || typeof signed !== 'object') return false;
  const s = signed as Partial<Signed<unknown>>;
  if (typeof s.key !== 'string' || typeof s.sig !== 'string' || s.body === undefined || s.body === null) return false;
  let text: string;
  try {
    text = canonicalJson(s.body);
  } catch {
    return false;
  }
  return verifyText(domain, text, s.sig, s.key);
}
