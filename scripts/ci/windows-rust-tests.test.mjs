// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { commands } from './windows-rust-tests.mjs'

const names = ['firmware', 'requests', 'reference', 'new_test']
const metadata = { workspace_members: ['core'], packages: [{ id: 'core', name: 'sx-core', targets: names.map((name) => ({ name, kind: ['test'] })) }] }
const selected = (plan) => plan.flatMap((args) => args.flatMap((arg, i) => arg === '--test' ? [args[i + 1]] : []))

test('every integration target runs exactly once across both Windows jobs', () => {
  const main = selected(commands(metadata, 'main'))
  const slow = selected(commands(metadata, 'slow'))
  assert.deepEqual(slow, ['firmware', 'requests'])
  assert.deepEqual([...main, ...slow].sort(), [...names].sort())
  assert.equal(new Set([...main, ...slow]).size, names.length)
})

test('the main part retains other crates, core unit targets, examples and doctests', () => {
  const plan = commands(metadata, 'main')
  assert.deepEqual(plan[0], ['test', '--locked', '--workspace', '--exclude', 'slicerx-desktop', '--exclude', 'sx-core'])
  assert.deepEqual(plan[1], ['test', '--locked', '-p', 'sx-core', '--lib', '--bins', '--examples'])
  assert.deepEqual(plan.at(-1), ['test', '--locked', '-p', 'sx-core', '--doc'])
})

test('a missing slow target or invalid part refuses instead of dropping coverage', () => {
  const missing = structuredClone(metadata)
  missing.packages[0].targets = missing.packages[0].targets.filter((t) => t.name !== 'requests')
  assert.throws(() => commands(missing, 'main'), /Missing integration target: requests/)
  assert.throws(() => commands({ ...metadata, workspace_members: [] }, 'slow'), /Missing sx-core/)
  assert.throws(() => commands(metadata, 'typo'), /Expected main or slow/)
})

test('a core package with only slow integrations does not run them again in main', () => {
  const onlySlow = structuredClone(metadata)
  onlySlow.packages[0].targets = onlySlow.packages[0].targets.slice(0, 2)
  const plan = commands(onlySlow, 'main')
  assert.equal(plan.length, 3)
  assert.deepEqual(selected(plan), [])
})

test('the release gate refuses a missing or failed slow Windows job', () => {
  const required = readFileSync(new URL('./required-checks.txt', import.meta.url), 'utf8').split(/\r?\n/).filter((s) => s && !s.startsWith('#'))
  assert.ok(required.includes('rust (windows-latest)'))
  assert.ok(required.includes('rust (windows-slow)'))
  const dir = mkdtempSync(join(tmpdir(), 'sx-windows-gate-'))
  const file = join(dir, 'checks.tsv')
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
  try {
    for (const state of ['missing', 'failure', 'success']) {
      const rows = required.flatMap((name, i) => name === 'rust (windows-slow)' && state === 'missing' ? [] : [`${i + 1}\t${name}\tcompleted\t${name === 'rust (windows-slow)' ? state : 'success'}`])
      writeFileSync(file, rows.join('\n') + '\n')
      const result = spawnSync(bash, ['-c', 'gh() { cat "$SX_FAKE_CHECKS"; }; export -f gh; bash scripts/ci/require-green.sh HEAD slicerx-oss/slicerx'], {
        encoding: 'utf8',
        env: { ...process.env, SX_FAKE_CHECKS: file.replaceAll('\\', '/'), SX_GREEN_WAIT: '0', SX_PUBLISH_ALLOW_RED: '0' },
      })
      assert.equal(result.status, state === 'success' ? 0 : 1, `${state}: ${result.error ?? result.stderr}`)
      if (state !== 'success') assert.match(result.stderr, new RegExp(`rust \\(windows-slow\\): ${state}`))
    }
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()))
    rmSync(dir, { recursive: true, force: true })
  }
})
