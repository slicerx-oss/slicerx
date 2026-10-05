// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Web Crypto for Hermes. The shared packages hash approval parameters and job files
// with crypto.subtle.digest('SHA-256') and sign approval tokens with HMAC-SHA-256;
// Hermes has TextEncoder but no crypto.subtle. SHA-256 comes from expo-crypto and HMAC
// is built on it (RFC 2104). Imported first by app/_layout.tsx.
import * as ExpoCrypto from 'expo-crypto'

const BLOCK = 64

type Bytes = Uint8Array<ArrayBuffer>

function bytesOf(data: BufferSource): Bytes {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  const view = data as ArrayBufferView
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer)
}

function algorithmName(a: AlgorithmIdentifier | { name: string; hash?: AlgorithmIdentifier }): string {
  return (typeof a === 'string' ? a : a.name).toUpperCase()
}

async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await ExpoCrypto.digest(ExpoCrypto.CryptoDigestAlgorithm.SHA256, data))
}

function concat(a: Bytes, b: Bytes): Bytes {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

/** HMAC-SHA-256 over expo-crypto's digest. */
export async function hmacSha256(key: Bytes, message: Bytes): Promise<Bytes> {
  let k = key.length > BLOCK ? await sha256(key) : key
  const padded = new Uint8Array(BLOCK)
  padded.set(k)
  k = padded
  const inner = k.map((b) => b ^ 0x36)
  const outer = k.map((b) => b ^ 0x5c)
  return sha256(concat(outer, await sha256(concat(inner, message))))
}

interface RawKey {
  type: 'secret'
  algorithm: { name: 'HMAC'; hash: { name: 'SHA-256' } }
  extractable: boolean
  usages: KeyUsage[]
  raw: Bytes
}

const subtle = {
  async digest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
    if (algorithmName(algorithm) !== 'SHA-256') throw new Error(`crypto.subtle.digest: only SHA-256 is available, not ${algorithmName(algorithm)}`)
    return (await sha256(bytesOf(data))).buffer
  },
  async importKey(format: string, keyData: BufferSource, algorithm: { name: string; hash?: AlgorithmIdentifier }, extractable: boolean, usages: KeyUsage[]): Promise<RawKey> {
    const hash = algorithm.hash ? algorithmName(algorithm.hash) : ''
    if (format !== 'raw' || algorithmName(algorithm) !== 'HMAC' || hash !== 'SHA-256') throw new Error('crypto.subtle.importKey: only raw HMAC SHA-256 keys are available')
    return { type: 'secret', algorithm: { name: 'HMAC', hash: { name: 'SHA-256' } }, extractable, usages, raw: bytesOf(keyData) }
  },
  async sign(algorithm: AlgorithmIdentifier, key: RawKey, data: BufferSource): Promise<ArrayBuffer> {
    if (algorithmName(algorithm) !== 'HMAC') throw new Error('crypto.subtle.sign: only HMAC is available')
    return (await hmacSha256(key.raw, bytesOf(data))).buffer
  },
}

const g = globalThis as { crypto?: Partial<Crypto> & { subtle?: unknown } }
g.crypto ??= {}
if (!g.crypto.getRandomValues) {
  g.crypto.getRandomValues = (<T extends ArrayBufferView | null>(array: T): T => {
    if (array) ExpoCrypto.getRandomValues(array as unknown as Uint8Array)
    return array
  }) as Crypto['getRandomValues']
}
if (!g.crypto.randomUUID) g.crypto.randomUUID = (() => ExpoCrypto.randomUUID()) as Crypto['randomUUID']
g.crypto.subtle ??= subtle as unknown as SubtleCrypto
