// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Which geometry engine the tests use is a choice (wasm by default, native with SX_TEST_GEOM_ENGINE=native),
// never a matter of which binary was built last: the two refuse some requests in different words.
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chooseGeomEngine, geomPaths } from '../evals/geom'

let dir = ''
let wasm = ''
let release = ''
let debug = ''

const stamp = (path: string, secondsAgo: number): void => {
  const t = new Date(Date.now() - secondsAgo * 1000)
  utimesSync(path, t, t)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eval-geom-'))
  mkdirSync(join(dir, 'release'))
  mkdirSync(join(dir, 'debug'))
  wasm = join(dir, 'sx_geom_wasm.wasm')
  release = join(dir, 'release', 'sx-geom')
  debug = join(dir, 'debug', 'sx-geom')
  for (const f of [wasm, release, debug]) writeFileSync(f, '')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('chooseGeomEngine', () => {
  it('picks the wasm even when a native binary is newer', () => {
    stamp(wasm, 600)
    stamp(release, 5)
    stamp(debug, 1)
    expect(chooseGeomEngine({ root: `${dir}/`, wasm, env: {} })).toEqual({ kind: 'wasm', path: wasm })
  })

  it('picks the wasm when it is the newer one too', () => {
    stamp(release, 600)
    stamp(wasm, 5)
    expect(chooseGeomEngine({ root: `${dir}/`, wasm, env: {} })).toEqual({ kind: 'wasm', path: wasm })
  })

  it('picks the native release binary with SX_TEST_GEOM_ENGINE=native, however old', () => {
    stamp(release, 600)
    stamp(wasm, 5)
    expect(chooseGeomEngine({ root: `${dir}/`, wasm, env: { SX_TEST_GEOM_ENGINE: 'native' } })).toEqual({ kind: 'native', path: release })
  })

  it('falls back to the debug build for native, and SLICERX_SX_GEOM_BIN names one outright', () => {
    rmSync(release)
    expect(chooseGeomEngine({ root: `${dir}/`, wasm, env: { SX_TEST_GEOM_ENGINE: 'native' } })).toEqual({ kind: 'native', path: debug })
    const named = join(dir, 'mine')
    writeFileSync(named, '')
    expect(chooseGeomEngine({ root: `${dir}/`, wasm, env: { SX_TEST_GEOM_ENGINE: 'native', SLICERX_SX_GEOM_BIN: named } })).toEqual({ kind: 'native', path: named })
  })

  it('finds the Windows build, sx-geom.exe', () => {
    rmSync(release)
    const exe = join(dir, 'release', 'sx-geom.exe')
    writeFileSync(exe, '')
    expect(chooseGeomEngine({ root: `${dir}/`, wasm, env: { SX_TEST_GEOM_ENGINE: 'native' } })).toEqual({ kind: 'native', path: exe })
  })

  it('does not fall back to native when the wasm is missing', () => {
    rmSync(wasm)
    expect(chooseGeomEngine({ root: `${dir}/`, wasm, env: {} })).toBeUndefined()
  })

  it('fails loudly when native was asked for and is not built', () => {
    rmSync(release)
    rmSync(debug)
    expect(() => chooseGeomEngine({ root: `${dir}/`, wasm, env: { SX_TEST_GEOM_ENGINE: 'native' } })).toThrow(/SX_TEST_GEOM_ENGINE=native.*cargo build -p sx-geom/)
  })

  it('rejects a value that is not wasm or native', () => {
    expect(() => chooseGeomEngine({ root: `${dir}/`, wasm, env: { SX_TEST_GEOM_ENGINE: 'nativ' } })).toThrow(/wasm or native/)
  })
})

describe('geomPaths', () => {
  it('gives paths the file system finds on this OS', () => {
    const { root, wasm } = geomPaths({})
    expect(existsSync(join(root, '..', 'Cargo.toml'))).toBe(true)
    expect(existsSync(join(wasm, '..', '..', 'Cargo.toml'))).toBe(true)
  })

  it('takes the web build from SX_GEOM_WASM when it is set', () => {
    expect(geomPaths({ SX_GEOM_WASM: wasm }).wasm).toBe(wasm)
  })
})
