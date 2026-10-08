// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// playwright-results.mjs on small Playwright JSON reports: flaky and failed tests by name, run errors, a missing report.
// Usage: node --test scripts/ci/playwright-results.test.mjs (pnpm test:scripts)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { results } from './playwright-results.mjs'

const script = join(dirname(fileURLToPath(import.meta.url)), 'playwright-results.mjs')
const spec = (title, ...tests) => ({ title, file: 'plate.spec.ts', tests: tests.map(([projectName, status]) => ({ projectName, status })) })
const report = {
  suites: [
    {
      title: 'plate.spec.ts',
      file: 'plate.spec.ts',
      specs: [spec('slices', ['desktop', 'expected'], ['phone', 'skipped']), spec('tooltips show', ['desktop', 'flaky'])],
      suites: [{ title: 'presets', file: 'plate.spec.ts', specs: [spec('a preset is saved', ['phone', 'unexpected'])] }],
    },
  ],
  errors: [],
  stats: { expected: 1, unexpected: 1, flaky: 1, skipped: 1 },
}

test('names the tests that passed only on a retry and the ones that failed, with describe blocks and project', () => {
  assert.deepEqual(results(report), {
    retried: ['plate.spec.ts > tooltips show [desktop]'],
    failed: ['plate.spec.ts > presets > a preset is saved [phone]'],
    errors: [],
  })
})

function run(json) {
  const dir = mkdtempSync(join(tmpdir(), 'pw-results-'))
  const file = join(dir, 'report.json')
  if (json !== undefined) writeFileSync(file, json)
  const out = spawnSync(process.execPath, [script, file, join(dir, 'retried.txt'), join(dir, 'failed.txt')], { encoding: 'utf8' })
  const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : null)
  return { status: out.status, stdout: out.stdout, stderr: out.stderr, retried: read('retried.txt'), failed: read('failed.txt') }
}

test('writes one name per line and passes when the run itself had no errors', () => {
  const r = run(JSON.stringify(report))
  assert.equal(r.status, 0)
  assert.equal(r.retried, 'plate.spec.ts > tooltips show [desktop]\n')
  assert.equal(r.failed, 'plate.spec.ts > presets > a preset is saved [phone]\n')
  assert.match(r.stdout, /1 passed, 1 passed only on a retry, 1 failed, 1 skipped/)
})

test('fails on an error outside any test, such as a web server that did not start', () => {
  const r = run(JSON.stringify({ ...report, errors: [{ message: 'Error: Timed out waiting 120000ms from config.webServer.\nmore' }] }))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /run error: Error: Timed out waiting 120000ms from config\.webServer\./)
})

test('fails when there is no report', () => {
  assert.equal(run(undefined).status, 1)
})
