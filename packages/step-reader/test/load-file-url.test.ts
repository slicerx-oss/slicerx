// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// loadOcct with a memory cap fetches the wasm itself. Node's fetch does not read file: URLs, so in Node a file URL is
// read from disk: a capped load of a wasm in another folder, under another name, reads STEP files and keeps its cap,
// and a missing file is refused for that file.
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { loadOcct, readStep } from '../src/index.ts'

const dir = mkdtempSync(join(tmpdir(), 'sx-step-file-url-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
copyFileSync(join(import.meta.dirname, '..', 'src', 'occt-import-js.wasm'), join(dir, 'reader-copy.wasm'))

describe('a capped load from a file URL in Node', () => {
  it('reads the wasm from disk and keeps the cap', async () => {
    const occt = await loadOcct({ wasm: pathToFileURL(join(dir, 'reader-copy.wasm')).href, maxMemoryMb: 512 })
    const read = readStep(occt, new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures', 'bracket-inch.stp'))), 'bracket-inch.stp', 'normal')
    expect(read.unit).toBe('inch')
    expect(read.triangles).toBe(464)
    expect(occt.outOfMemory).toBe(false)
  })

  it('refuses a file URL that names no file', async () => {
    await expect(loadOcct({ wasm: pathToFileURL(join(dir, 'missing.wasm')), maxMemoryMb: 512 })).rejects.toThrow(/missing\.wasm/)
  })
})
