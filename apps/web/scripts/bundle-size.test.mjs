// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs bundle-size.mjs on small builds: a shell under its budget passes, one over it fails, and a chunk that loads
// later never counts toward the shell.
// Usage: node --test apps/web/scripts/bundle-size.test.mjs (pnpm test:scripts)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = join(dirname(fileURLToPath(import.meta.url)), 'bundle-size.mjs')

/** Script text that gzip cannot shrink much: about `kb` KB gzip of random letters in a comment. */
const bulk = (kb) => `/* ${randomBytes(Math.round(kb * 1024)).toString('base64')} */\nexport const x = 1\n`

/** A build with an entry, one chunk it imports and one it loads later, each with the text given. */
function build({ entry, shared, lazy }) {
  const dist = mkdtempSync(join(tmpdir(), 'bundle-size-'))
  const files = { 'static/entry.js': entry, 'static/shared.js': shared, 'static/later.js': lazy }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dist, path)), { recursive: true })
    writeFileSync(join(dist, path), text)
  }
  const manifest = {
    'index.html': { file: 'static/entry.js', isEntry: true, imports: ['_shared.js'], dynamicImports: ['src/later.ts'] },
    '_shared.js': { file: 'static/shared.js' },
    'src/later.ts': { file: 'static/later.js', isDynamicEntry: true },
  }
  mkdirSync(join(dist, '.vite'))
  writeFileSync(join(dist, '.vite', 'manifest.json'), JSON.stringify(manifest))
  return dist
}

function check(dist) {
  const r = spawnSync(process.execPath, [script, dist], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

test('passes a shell under the budget, and does not count a chunk that loads later', () => {
  const dist = build({ entry: bulk(90), shared: bulk(90), lazy: bulk(400) })
  try {
    const r = check(dist)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /shell JS: \d+\.\d KB gzip \(budget 188 KB\)/)
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})

test('fails a shell over the budget, counting the chunks the entry imports', () => {
  const dist = build({ entry: bulk(110), shared: bulk(110), lazy: 'export const y = 2\n' })
  try {
    const r = check(dist)
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /bundle-size: failed/)
  } finally {
    rmSync(dist, { recursive: true, force: true })
  }
})
