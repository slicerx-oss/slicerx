// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { test } from 'node:test'

const root = resolve(import.meta.dirname, '..')
const run = (...args) => spawnSync('node', ['scripts/edition-build.mjs', ...args], { cwd: root, encoding: 'utf8' })

test('edition-build passes the config to every step', () => {
  const config = 'packages/edition-config/fixtures/acme/acme.json'
  const desktop = run(config, '--target', 'desktop', '--dry-run')
  assert.equal(desktop.status, 0, desktop.stderr)
  const lines = desktop.stdout.trim().split('\n')
  assert.match(lines[0], /check .*acme\.json$/)
  assert.match(lines[1], /build:wasm$/)
  assert.match(lines[2], /tauri .*acme\.json desktop src-tauri\/gen\/edition\.conf\.json$/)
  assert.match(lines[3], /tauri build --config src-tauri\/gen\/edition\.conf\.json$/)

  const web = run(config, '--target', 'web', '--skip-wasm', '--dry-run')
  assert.equal(web.status, 0, web.stderr)
  assert.deepEqual(web.stdout.trim().split('\n').map((l) => l.split(':')[1].trim()), ['check the config', 'build the browser app'])
})

test('edition-build refuses a missing config or an unknown target', () => {
  assert.equal(run('editions/nope/edition.config.ts', '--dry-run').status, 1)
  assert.equal(run('packages/edition-config/fixtures/acme/acme.json', '--target', 'phone').status, 2)
  assert.equal(run().status, 2)
})
