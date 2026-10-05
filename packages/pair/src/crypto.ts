// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The only primitives the pairing protocol uses: X25519, Ed25519, HKDF and HMAC over SHA-256,
// and XChaCha20-Poly1305. All come from the audited noble libraries, which are plain
// JavaScript and run the same in browsers, Node, Tauri webviews and React Native.
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js'
import { concat, frame, u64be, utf8 } from './bytes'

/** Clock and randomness, injected so tests are deterministic and React Native can supply its own RNG. */
export interface PairEnv {
  /** Milliseconds since the epoch. */
  now(): number
  /** Cryptographically secure random bytes. */
  random(length: number): Uint8Array
}

export const defaultEnv: PairEnv = {
  now: () => Date.now(),
  random: (length) => globalThis.crypto.getRandomValues(new Uint8Array(length)),
}

export const PROTOCOL = 'sx-pair/v1'

export interface KeyPair {
  secretKey: Uint8Array
  publicKey: Uint8Array
}

export function dhKeyPair(env: PairEnv): KeyPair {
  const secretKey = env.random(32)
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) }
}

/** Throws on low-order peer keys, which would give an all-zero secret. */
export function dh(secretKey: Uint8Array, peerPublic: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(secretKey, peerPublic)
}

export function signKeyPair(env: PairEnv): KeyPair {
  const secretKey = env.random(32)
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) }
}

export function sign(secretKey: Uint8Array, label: string, message: Uint8Array): Uint8Array {
  return ed25519.sign(frame(PROTOCOL, label, message), secretKey)
}

export function verifySig(publicKey: Uint8Array, label: string, message: Uint8Array, sig: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, frame(PROTOCOL, label, message), publicKey)
  } catch {
    // Malformed keys or signatures are a failed check, never an exception at the boundary.
    return false
  }
}

export const sha256 = (data: Uint8Array): Uint8Array => nobleSha256(data)
export const sha256Stream = () => nobleSha256.create()

export function kdf(ikm: Uint8Array, salt: Uint8Array | undefined, label: string, length = 32): Uint8Array {
  return hkdf(nobleSha256, ikm, salt, utf8(`${PROTOCOL} ${label}`), length)
}

export function mac(key: Uint8Array, label: string, ...parts: (Uint8Array | string)[]): Uint8Array {
  return hmac(nobleSha256, key, frame(PROTOCOL, label, ...parts))
}

const NONCE_BYTES = 24

/** Nonce from direction and counter. Keys are fresh per session and direction, so these never repeat. */
function counterNonce(direction: number, counter: number): Uint8Array {
  return concat(new Uint8Array([direction]), u64be(counter), new Uint8Array(NONCE_BYTES - 9))
}

export function seal(key: Uint8Array, direction: number, counter: number, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return xchacha20poly1305(key, counterNonce(direction, counter), aad).encrypt(plaintext)
}

/** Returns null when the tag does not verify. */
export function open(key: Uint8Array, direction: number, counter: number, aad: Uint8Array, ciphertext: Uint8Array): Uint8Array | null {
  try {
    return xchacha20poly1305(key, counterNonce(direction, counter), aad).decrypt(ciphertext)
  } catch {
    return null
  }
}

/** Six decimal digits for people to compare, shown as "123 456". */
export function sasDigits(material: Uint8Array): string {
  const b = material
  // 40 bits mod 10^6: the bias is under 1e-6, far below the guessing odds it protects.
  const n = ((b[0] ?? 0) * 2 ** 32 + (((b[1] ?? 0) << 24) >>> 0) + ((b[2] ?? 0) << 16) + ((b[3] ?? 0) << 8) + (b[4] ?? 0)) % 1_000_000
  const s = n.toString().padStart(6, '0')
  return `${s.slice(0, 3)} ${s.slice(3)}`
}
