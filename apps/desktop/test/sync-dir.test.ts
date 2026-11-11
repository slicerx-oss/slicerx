// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// pack-mcp.mjs copies the packed MCP server into the app's resources with syncDir: a file with the same bytes keeps its
// modification time, so cargo (which watches the resources through tauri_build) has nothing to rebuild.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error a plain .mjs build script, no types
import { syncDir } from '../scripts/sync-dir.mjs'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sx-sync-dir-'))
  roots.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

const PAST = new Date('2026-01-01T00:00:00Z')
const mtime = (file: string) => statSync(file).mtimeMs

describe('syncDir', () => {
  it('leaves every file and folder untouched when the bytes are the same', () => {
    const files = { 'a.mjs': 'one', 'chunks/b.mjs': 'two', 'step-reader/c.wasm': 'three' }
    const from = tree(files)
    const to = tree(files)
    for (const p of [...Object.keys(files), 'chunks', 'step-reader', '.']) utimesSync(join(to, p), PAST, PAST)
    const r = syncDir(from, to)
    expect(r).toEqual({ written: [], removed: [], same: 3 })
    for (const p of [...Object.keys(files), 'chunks', 'step-reader', '.']) expect(mtime(join(to, p)), p).toBe(PAST.getTime())
  })

  it('writes only the files whose bytes differ or that are new', () => {
    const from = tree({ 'a.mjs': 'one', 'b.mjs': 'changed', 'new/c.mjs': 'new' })
    const to = tree({ 'a.mjs': 'one', 'b.mjs': 'old' })
    utimesSync(join(to, 'a.mjs'), PAST, PAST)
    const r = syncDir(from, to)
    expect(r.written.sort()).toEqual(['b.mjs', 'new/c.mjs'])
    expect(r.removed).toEqual([])
    expect(readFileSync(join(to, 'b.mjs'), 'utf8')).toBe('changed')
    expect(readFileSync(join(to, 'new', 'c.mjs'), 'utf8')).toBe('new')
    expect(mtime(join(to, 'a.mjs'))).toBe(PAST.getTime())
  })

  it('removes what the pack no longer makes, but never a kept name at the top', () => {
    const from = tree({ 'a.mjs': 'one', 'x/y.mjs': 'file now' })
    const to = tree({ 'a.mjs': 'one', '.gitkeep': '', 'chunks/old-123.mjs': 'stale', 'x/y.mjs/inner': 'was a folder', 'gone.txt': 'stale' })
    const r = syncDir(from, to, { keep: ['.gitkeep'] })
    expect(r.removed.sort()).toEqual(['chunks', 'gone.txt', 'x/y.mjs'])
    expect(existsSync(join(to, '.gitkeep'))).toBe(true)
    expect(existsSync(join(to, 'chunks'))).toBe(false)
    expect(readFileSync(join(to, 'x', 'y.mjs'), 'utf8')).toBe('file now')
  })
})
