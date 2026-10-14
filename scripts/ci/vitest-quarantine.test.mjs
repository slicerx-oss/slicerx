// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The vitest side of the quarantine: the reporter's failure names (vitest-flaky-reporter.mjs), `flaky-check.sh failed`
// on them, and the stale quarantine warning in `flaky-check.sh lint` and `report`.
// Usage: node --test scripts/ci/vitest-quarantine.test.mjs (pnpm test:scripts)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import FlakyReporter, { failures } from './vitest-flaky-reporter.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const checker = join(here, 'flaky-check.sh')
const issue = (n) => `https://github.com/slicerx-oss/slicerx/issues/${n}`

// Small stand-ins for vitest's reported tasks: just the members the reporter reads.
const testCase = (fullName, mod) => ({ fullName, module: mod })
const suite = (fullName, errors = []) => ({ fullName, errors: () => errors })
const testModule = (file, { state = 'passed', errors = [], suites = [], failed = [] } = {}) => {
  const mod = { moduleId: join(process.cwd(), file), state: () => state, errors: () => errors }
  mod.children = { allSuites: () => suites.values(), allTests: (s) => (s === 'failed' ? failed.map((n) => testCase(n, mod)) : []).values() }
  return mod
}

test('names each test that failed on every try, with its file and suites', () => {
  const run = [
    testModule('test/ok.test.ts'),
    testModule('test/plate.test.ts', { state: 'failed', failed: ['presets > a preset is saved', 'top level'] }),
  ]
  assert.deepEqual(failures(run, [], 'failed'), ['test/plate.test.ts > presets > a preset is saved', 'test/plate.test.ts > top level'])
  assert.deepEqual(failures([testModule('test/ok.test.ts')], [], 'passed'), [])
})

test('marks every error outside a test with "!", so no list can excuse it', () => {
  const run = [
    testModule('test/load.test.ts', { state: 'failed', errors: [{ message: 'Cannot find module ./gone\n  at x' }] }),
    testModule('test/hook.test.ts', { state: 'failed', suites: [suite('presets', [{ message: 'afterAll hook timed out' }])] }),
    testModule('test/odd.test.ts', { state: 'failed' }),
  ]
  assert.deepEqual(failures(run, [{ message: 'boom' }], 'interrupted'), [
    '!test/load.test.ts: Cannot find module ./gone',
    '!test/hook.test.ts > presets: afterAll hook timed out',
    '!test/odd.test.ts: failed without a failed test',
    '!unhandled error: boom',
    '!the run was interrupted',
  ])
})

test('the reporter writes retried tests to SX_FLAKY_OUT and failed ones to SX_FAILED_OUT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vq-reporter-'))
  const env = { SX_FLAKY_OUT: process.env.SX_FLAKY_OUT, SX_FAILED_OUT: process.env.SX_FAILED_OUT }
  process.env.SX_FLAKY_OUT = join(dir, 'retried.txt')
  process.env.SX_FAILED_OUT = join(dir, 'failed.txt')
  const log = console.log
  console.log = () => {}
  try {
    const mod = testModule('test/plate.test.ts', { state: 'failed', failed: ['slices'] })
    const reporter = new FlakyReporter()
    reporter.onTestCaseResult({ ...testCase('tooltips show', mod), diagnostic: () => ({ retryCount: 1 }), result: () => ({ state: 'passed' }) })
    reporter.onTestCaseResult({ ...testCase('passes', mod), diagnostic: () => ({ retryCount: 0 }), result: () => ({ state: 'passed' }) })
    reporter.onTestRunEnd([mod], [], 'failed')
  } finally {
    console.log = log
    for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
  assert.equal(readFileSync(join(dir, 'retried.txt'), 'utf8'), 'test/plate.test.ts > tooltips show\n')
  assert.equal(readFileSync(join(dir, 'failed.txt'), 'utf8'), 'test/plate.test.ts > slices\n')
})

// A temporary FLAKY_DIR with the given entry files, and flaky-check.sh run against it.
function lists(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'vq-lists-')).replaceAll('\\', '/')
  mkdirSync(join(dir, 'flaky.d'))
  mkdirSync(join(dir, 'quarantine.d'))
  for (const [path, line] of Object.entries(entries)) writeFileSync(join(dir, path), `${line}\n`)
  return dir
}
function check(dir, args, env = {}) {
  const r = spawnSync('bash', [checker, ...args], { encoding: 'utf8', env: { ...process.env, FLAKY_DIR: dir, FLAKY_TODAY: '2026-10-14', ...env } })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
function failedFile(dir, ...names) {
  const file = join(dir, 'failed.txt')
  writeFileSync(file, names.map((n) => `${n}\n`).join(''))
  return file
}

test('failed: passes when every failed test is quarantined, and counts each one', () => {
  const dir = lists({ 'quarantine.d/12-plate-slices.txt': `plate.test.ts > slices | sam | 2026-10-14 | ${issue(12)} | times out on busy runners` })
  const r = check(dir, ['failed', failedFile(dir, 'test/plate.test.ts > slices')])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /failed, quarantined and counted: test\/plate\.test\.ts > slices/)
  assert.match(r.out, /::warning title=Quarantined test failed::/)
})

test('failed: fails on a failed test that is on no list, and on any "!" line', () => {
  const dir = lists({ 'quarantine.d/12-plate-slices.txt': `plate.test.ts > slices | sam | 2026-10-14 | ${issue(12)} | times out` })
  let r = check(dir, ['failed', failedFile(dir, 'test/plate.test.ts > slices', 'test/plate.test.ts > presets')])
  assert.equal(r.code, 1)
  assert.match(r.out, /::error title=Failed test::test\/plate\.test\.ts > presets/)
  // the "!" line quotes a quarantined name and still fails
  r = check(dir, ['failed', failedFile(dir, '!test/plate.test.ts > slices: afterAll hook timed out')])
  assert.equal(r.code, 1)
  assert.match(r.out, /::error title=Error outside a test::test\/plate\.test\.ts > slices: afterAll hook timed out/)
})

test('failed: a flaky entry excuses a failure only once its deadline has passed', () => {
  const dir = lists({ 'flaky.d/14-plate-slices.txt': `plate.test.ts > slices | sam | 2026-10-12 | 2026-10-13 | ${issue(14)} | times out` })
  const file = failedFile(dir, 'test/plate.test.ts > slices')
  assert.equal(check(dir, ['failed', file], { FLAKY_TODAY: '2026-10-13' }).code, 1)
  assert.equal(check(dir, ['failed', file], { FLAKY_TODAY: '2026-10-14' }).code, 0)
})

test('lint: a fresh quarantine entry passes without a stale warning', () => {
  const dir = lists({ 'quarantine.d/12-plate-slices.txt': `plate.test.ts > slices | sam | 2026-10-10 | ${issue(12)} | times out` })
  const r = check(dir, ['lint'])
  assert.equal(r.code, 0, r.err)
  assert.doesNotMatch(r.out + r.err, /Stale quarantine entry|STALE/)
  assert.match(r.out, /1 quarantined, 0 stale/)
})

test('lint: an entry over 14 days old warns loudly with its age and issue, without failing', () => {
  const dir = lists({
    'quarantine.d/12-plate-slices.txt': `plate.test.ts > slices | sam | 2026-09-24 | ${issue(12)} | times out`,
    'flaky.d/15-old-flake.txt': `old flake | kim | 2026-09-20 | 2026-09-21 | ${issue(15)} | races the timer`,
  })
  let r = check(dir, ['lint'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /::warning title=Stale quarantine entry::quarantine\.d\/12-plate-slices\.txt \("plate\.test\.ts > slices"\) is 20 days old \(limit 14\), issue https:\/\/github\.com\/slicerx-oss\/slicerx\/issues\/12/)
  assert.match(r.out, /::warning title=Stale quarantine entry::flaky\.d\/15-old-flake\.txt \("old flake"\) is 24 days old/)
  assert.match(r.out, /2 stale/)
  assert.match(check(dir, ['report']).out, /STALE plate\.test\.ts > slices \| sam \| 20d old/)
  // the limit is a setting
  r = check(dir, ['lint'], { SX_QUARANTINE_MAX_DAYS: '30' })
  assert.equal(r.code, 0, r.err)
  assert.doesNotMatch(r.out, /Stale quarantine entry/)
  // exactly 14 days old is still within the limit
  const edge = lists({ 'quarantine.d/12-plate-slices.txt': `plate.test.ts > slices | sam | 2026-09-30 | ${issue(12)} | times out` })
  assert.doesNotMatch(check(edge, ['lint']).out, /Stale quarantine entry/)
})

test('lint: a quarantine entry without a date added, or without an issue, fails', () => {
  let r = check(lists({ 'quarantine.d/12-plate-slices.txt': `plate.test.ts > slices | sam | | ${issue(12)} | times out` }), ['lint'])
  assert.equal(r.code, 1)
  assert.match(r.err, /needs a date added as YYYY-MM-DD/)
  r = check(lists({ 'quarantine.d/12-plate-slices.txt': 'plate.test.ts > slices | sam | 2026-10-14 | #12 | times out' }), ['lint'])
  assert.equal(r.code, 1)
  assert.match(r.err, /needs an issue link/)
})
