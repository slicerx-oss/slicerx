// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Test helpers: load the vendored Orca profiles by name, open the real preset bundles.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import type { ProfileImport } from '@slicerx/contracts/settings'
import { importOrcaProfile } from './import'

const root = fileURLToPath(new URL('../fixtures/profiles/', import.meta.url))

interface Index {
  orca_commit: string
  vendors: Record<string, Record<string, Record<string, string>>>
}

export const profileIndex = JSON.parse(readFileSync(root + 'index.json', 'utf8')) as Index

export function vendorResolver(vendor: string): (name: string) => unknown {
  const byName = new Map<string, string>()
  for (const t of Object.values(profileIndex.vendors[vendor] ?? {})) for (const [n, rel] of Object.entries(t)) byName.set(n, rel)
  return (name) => {
    const rel = byName.get(name)
    return rel ? (JSON.parse(readFileSync(root + rel, 'utf8')) as unknown) : undefined
  }
}

export function loadProfile(vendor: string, name: string): ProfileImport {
  const resolve = vendorResolver(vendor)
  return importOrcaProfile(resolve(name), resolve)
}

export function allProfileNames(): [string, string][] {
  const out: [string, string][] = []
  for (const [vendor, types] of Object.entries(profileIndex.vendors)) for (const t of Object.values(types)) for (const n of Object.keys(t)) out.push([vendor, n])
  return out
}

/** A zip's entries, for tests that open real preset bundles. Stored and deflated entries only. */
export function unzipForTest(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = bytes.length - 22
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error('not a zip')
  const count = view.getUint16(eocd + 10, true)
  let at = view.getUint32(eocd + 16, true)
  const out = new Map<string, Uint8Array>()
  for (let n = 0; n < count; n++) {
    const method = view.getUint16(at + 10, true)
    const csize = view.getUint32(at + 20, true)
    const nameLen = view.getUint16(at + 28, true)
    const extraLen = view.getUint16(at + 30, true)
    const commentLen = view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen))
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    const raw = bytes.subarray(start, start + csize)
    out.set(name, method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw)
    at += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** A real preset bundle or project from fixtures/preset-files. */
export function presetFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/preset-files/${name}`, import.meta.url))))
}
