// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs check-dashes.mjs on a small repository: third-party code and data are skipped, our own code is not.
// Usage: node --test scripts/check-dashes.test.mjs (pnpm test:scripts)
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-dashes.mjs')
const dash = String.fromCharCode(0x2014)

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'check-dashes-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['add', '-A'], { cwd: dir })
  return dir
}

function check(dir) {
  const r = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' })
  return { code: r.status, out: r.stdout }
}

test('skips vendored code and annotated data, and still catches a dash in our own code', () => {
  const dir = repo({
    'REUSE.toml': `version = 1\n\n[[annotations]]\npath = ["packages/profiles/filaments/**", "packages/profiles/gcode.json"]\nSPDX-License-Identifier = "AGPL-3.0-or-later"\n`,
    'packages/vendor/lib/SOURCE.md': 'Copied from upstream.\n',
    'packages/vendor/lib/src/a.rs': `// upstream ${dash} wording\n`,
    'packages/profiles/filaments/pla.json': `{ "note": "maker ${dash} text" }\n`,
    'packages/profiles/gcode.json': `{ "note": "maker ${dash} text" }\n`,
    'packages/app/src/ours.ts': `// ours ${dash} not allowed\n`,
    'packages/app/src/clean.ts': '// plain\n',
  })
  try {
    const { code, out } = check(dir)
    assert.equal(code, 1)
    assert.match(out, /packages\/app\/src\/ours\.ts:1:/)
    assert.doesNotMatch(out, /vendor|profiles/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a SOURCE.md only covers its own folder', () => {
  const dir = repo({
    'packages/vendor/lib/SOURCE.md': 'Copied from upstream.\n',
    'packages/vendor/libx/b.rs': `// ${dash}\n`,
  })
  try {
    assert.equal(check(dir).code, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('passes when only third-party files have dashes', () => {
  const dir = repo({
    'packages/vendor/lib/SOURCE.md': 'Copied from upstream.\n',
    'packages/vendor/lib/README.md': `upstream ${dash} wording\n`,
    'packages/app/src/clean.ts': '// plain\n',
  })
  try {
    assert.equal(check(dir).code, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
