// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { mock, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkPartition, commands, createTimer, describe, loadWeights, partition, summary, unweightedWarning, writeSummary } from './windows-rust-tests.mjs'

const script = fileURLToPath(new URL('./windows-rust-tests.mjs', import.meta.url))

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

const withTargets = (list) => ({ workspace_members: ['core'], packages: [{ id: 'core', name: 'sx-core', targets: list.map((name) => ({ name, kind: ['test'] })) }] })
const sized = { rest: 100, targets: { a: 60, b: 50, c: 40, d: 30, e: 20, f: 10 } }
const sizedMetadata = withTargets(Object.keys(sized.targets))
const assigned = (parts) => parts.map((part) => part.items.map((item) => item.name))

test('the main and slow plans are the same as before parts existed', () => {
  const workspace = ['test', '--locked', '--workspace', '--exclude', 'slicerx-desktop', '--exclude', 'sx-core']
  const unit = ['test', '--locked', '-p', 'sx-core', '--lib', '--bins', '--examples']
  const doc = ['test', '--locked', '-p', 'sx-core', '--doc']
  assert.deepEqual(commands(metadata, 'main'), [workspace, unit, ['test', '--locked', '-p', 'sx-core', '--test', 'new_test', '--test', 'reference'], doc])
  assert.deepEqual(commands(metadata, 'slow'), [['test', '--locked', '-p', 'sx-core', '--test', 'firmware', '--test', 'requests']])
})

test('parts fill the lightest part with the heaviest item first, ties to the lowest part and the earliest name', () => {
  assert.deepEqual(assigned(partition(sizedMetadata, 2, sized).parts), [['rest', 'c', 'e'], ['a', 'b', 'd', 'f']])
  assert.deepEqual(assigned(partition(sizedMetadata, 3, sized).parts), [['rest'], ['a', 'd', 'e'], ['b', 'c', 'f']])
  const equal = { rest: 10, targets: { x: 10, y: 10, z: 10 } }
  assert.deepEqual(assigned(partition(withTargets(['z', 'y', 'x']), 2, equal).parts), [['rest', 'y'], ['x', 'z']])
})

test('every part computes the same partition whatever order cargo lists the targets in', () => {
  const forward = partition(sizedMetadata, 3, sized)
  const backward = partition(withTargets(Object.keys(sized.targets).reverse()), 3, sized)
  assert.deepEqual(backward, forward)
  assert.deepEqual(partition(sizedMetadata, 3, sized), forward)
  const plans = [1, 2, 3].map((part) => commands(sizedMetadata, part, { of: 3, weights: sized }))
  assert.deepEqual(plans, [1, 2, 3].map((part) => commands(withTargets(['f', 'e', 'd', 'c', 'b', 'a']), part, { of: 3, weights: sized })))
})

test('the parts are balanced on a fixture shaped like the repository', () => {
  const heavy = { firmware: 324, requests: 330, determinism: 217, arrange_layer_one: 152, cancel_rerun: 104, organic2: 101, object_labels: 83, internal_solid: 61, floating_shell: 39, brim_bed: 26, collisions: 25, overhang_fan: 24, by_layer_order: 20 }
  const targets = { ...heavy, ...Object.fromEntries(Array.from({ length: 66 }, (_, i) => [`small_${i}`, 2])) }
  const fixture = withTargets(Object.keys(targets))
  for (const count of [2, 3]) {
    const { parts } = partition(fixture, count, { rest: 700, targets })
    const loads = parts.map((part) => part.load)
    assert.ok(Math.max(...loads) - Math.min(...loads) <= 2, `${count} parts: ${loads}`)
    assert.equal(loads.reduce((a, b) => a + b, 0), 700 + Object.values(targets).reduce((a, b) => a + b, 0))
    assert.ok(parts[0].items.some((item) => item.rest))
  }
})

test('each part runs rest once and every integration target in exactly one part, new files included', () => {
  const grown = withTargets([...Object.keys(sized.targets), 'brand_new', 'another_new'])
  for (const count of [1, 2, 3, 4]) {
    const plans = Array.from({ length: count }, (_, i) => commands(grown, i + 1, { of: count, weights: sized }))
    assert.deepEqual(plans.flatMap(selected).sort(), [...Object.keys(sized.targets), 'brand_new', 'another_new'].sort())
    assert.equal(plans.flat().filter((args) => args.includes('--workspace')).length, 1)
    assert.equal(plans.flat().filter((args) => args.includes('--doc')).length, 1)
    assert.equal(plans.flat().filter((args) => args.includes('--lib')).length, 1)
  }
  assert.deepEqual(commands(sizedMetadata, 1, { of: 1, weights: sized }), [
    ['test', '--locked', '--workspace', '--exclude', 'slicerx-desktop', '--exclude', 'sx-core'],
    ['test', '--locked', '-p', 'sx-core', '--lib', '--bins', '--examples'],
    ['test', '--locked', '-p', 'sx-core', ...'abcdef'.split('').flatMap((name) => ['--test', name])],
    ['test', '--locked', '-p', 'sx-core', '--doc'],
  ])
})

test('a target with no weight counts as 5 s, is named in a warning and still lands in one part', () => {
  const grown = withTargets([...Object.keys(sized.targets), 'unlisted'])
  const { parts, unweighted } = partition(grown, 2, sized)
  assert.deepEqual(unweighted, ['unlisted'])
  assert.equal(parts.flatMap((part) => part.items).find((item) => item.name === 'unlisted').weight, 5)
  assert.equal(parts.reduce((sum, part) => sum + part.load, 0), 310 + 5)
  assert.equal(parts.filter((part) => part.items.some((item) => item.name === 'unlisted')).length, 1)
  assert.match(unweightedWarning(unweighted), /unlisted/)
  assert.match(unweightedWarning(unweighted), /5 s/)
  assert.equal(unweightedWarning(partition(sizedMetadata, 2, sized).unweighted), null)
})

test('a target in no part or in two parts refuses', () => {
  const targets = ['a', 'b']
  const part = (...items) => ({ items: items.map((name) => ({ name, rest: name === 'rest', weight: 1 })), load: items.length })
  checkPartition(targets, [part('rest', 'a'), part('b')])
  assert.throws(() => checkPartition(targets, [part('rest', 'a'), part()]), /dropped integration target b: it is in no part/)
  assert.throws(() => checkPartition(targets, [part('rest', 'a', 'b'), part('b')]), /repeated integration target b: it is in 2 parts/)
  assert.throws(() => checkPartition(targets, [part('a', 'b'), part()]), /dropped the rest/)
  assert.throws(() => checkPartition(targets, [part('rest', 'a', 'b'), part('rest')]), /repeated the rest/)
  assert.throws(() => checkPartition(targets, [part('rest', 'a', 'b', 'gone')]), /unknown integration target: gone/)
})

test('a bad part number, part count or weight refuses', () => {
  const options = { of: 2, weights: sized }
  assert.throws(() => commands(sizedMetadata, 0, options), /Expected a part from 1 to 2/)
  assert.throws(() => commands(sizedMetadata, 3, options), /Expected a part from 1 to 2/)
  assert.throws(() => commands(sizedMetadata, 1, { weights: sized }), /Expected --of/)
  assert.throws(() => partition(sizedMetadata, 0, sized), /part count/)
  assert.throws(() => commands({ ...sizedMetadata, workspace_members: [] }, 1, options), /Missing sx-core/)
  const dir = mkdtempSync(join(tmpdir(), 'sx-rust-weights-'))
  try {
    for (const bad of [{ targets: {} }, { rest: 0, targets: {} }, { rest: 5, targets: { a: -1 } }, { rest: 5, targets: { a: 'x' } }]) {
      writeFileSync(join(dir, 'weights.json'), JSON.stringify(bad))
      assert.throws(() => loadWeights(join(dir, 'weights.json')), /Expected a positive weight/)
    }
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the checked-in weights are positive numbers for rest and each target', () => {
  const weights = loadWeights()
  assert.ok(weights.rest > 0)
  assert.ok(Object.keys(weights.targets).length > 10)
})

test('the command line prints the plan and names a target with no weight', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-rust-parts-'))
  const file = join(dir, 'metadata.json')
  const run = (...args) => spawnSync(process.execPath, [script, ...args, '--metadata', file], { encoding: 'utf8' })
  try {
    writeFileSync(file, JSON.stringify(withTargets(['firmware', 'requests', 'determinism', 'brand_new'])))
    const part = run('1', '--of', '2', '--plan')
    assert.equal(part.status, 0, part.stderr)
    assert.match(part.stderr, /no weight in rust-part-weights\.json for 1 sx-core integration target.*: brand_new/)
    const plan = JSON.parse(part.stdout)
    assert.deepEqual(plan, commands(withTargets(['firmware', 'requests', 'determinism', 'brand_new']), 1, { of: 2, weights: loadWeights() }))
    const main = run('main', '--plan')
    assert.equal(main.status, 0, main.stderr)
    assert.equal(main.stderr, '')
    assert.deepEqual(JSON.parse(main.stdout), commands(withTargets(['firmware', 'requests', 'determinism', 'brand_new']), 'main'))
    const all = run('--of', '2', '--partition')
    assert.equal(all.status, 0, all.stderr)
    assert.match(all.stdout, /^part 1 of 2: weight \d+ s, \d+ items\n {2}rest 700/)
    assert.match(all.stdout, /\npart 2 of 2: weight \d+ s/)
    assert.notEqual(run('3', '--of', '2', '--plan').status, 0)
    assert.notEqual(run('typo', '--plan').status, 0)
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the timer measures each test binary from its Running line to the next one', () => {
  let clock = 0
  const timer = createTimer(() => clock)
  const at = (ms, line) => {
    clock = ms
    timer.feed(line)
  }
  at(0, '   Compiling sx-core v0.1.0')
  at(1000, '\u001b[1m\u001b[92m     Running\u001b[0m unittests src/lib.rs (target/debug/deps/sx_core-0123456789abcdef)')
  at(84000, '     Running tests\\firmware.rs (target\\debug\\deps\\firmware-0123456789abcdef.exe)')
  at(90500, 'test result: ok. 3 passed; 0 failed')
  at(410500, '   Doc-tests sx_core')
  clock = 450000
  timer.finish()
  timer.finish()
  assert.deepEqual(timer.rows, [
    { name: 'sx_core', source: 'unittests src/lib.rs', seconds: 83 },
    { name: 'firmware', source: 'tests/firmware.rs', seconds: 326.5 },
    { name: 'sx_core', source: 'doc tests', seconds: 39.5 },
  ])
})

test('the summary lists the slowest binaries first and goes to the step summary when one is set', () => {
  const rows = [{ name: 'fast', source: 'tests/fast.rs', seconds: 1.04 }, { name: 'slow', source: 'tests/slow.rs', seconds: 320.26 }]
  const text = summary(rows, 'Rust test binaries, Windows part 2 of 3', 794)
  assert.equal(text, [
    '### Rust test binaries, Windows part 2 of 3',
    '',
    'Predicted weight 794 s, measured binary time 321.3 s.',
    '',
    '| binary | source | seconds |',
    '| --- | --- | ---: |',
    '| slow | tests/slow.rs | 320.3 |',
    '| fast | tests/fast.rs | 1.0 |',
    '',
  ].join('\n'))
  const dir = mkdtempSync(join(tmpdir(), 'sx-rust-summary-'))
  const file = join(dir, 'summary.md')
  const log = mock.method(console, 'log', () => {})
  try {
    writeSummary(text, { GITHUB_STEP_SUMMARY: file })
    assert.equal(readFileSync(file, 'utf8'), `${text}\n`)
    assert.equal(log.mock.callCount(), 0)
    writeSummary(text, {})
    assert.deepEqual(log.mock.calls.map((call) => call.arguments), [[text]])
  } finally {
    log.mock.restore()
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('describe prints the weight sum and items of each part', () => {
  const lines = describe(partition(sizedMetadata, 2, sized).parts)
  assert.deepEqual(lines, ['part 1 of 2: weight 160 s, 3 items', '  rest 100, c 40, e 20', 'part 2 of 2: weight 150 s, 4 items', '  a 60, b 50, d 30, f 10'])
})

test('the rest goes to part 1 even when a target outweighs it', () => {
  const heavy = { rest: 10, targets: { huge: 500, big: 400, small: 5 } }
  const meta = withTargets(Object.keys(heavy.targets))
  for (const count of [1, 2, 3]) {
    const { parts } = partition(meta, count, heavy)
    assert.ok(parts[0].items.some((item) => item.rest), `${count} parts`)
    assert.equal(parts.flatMap((part) => part.items).filter((item) => item.rest).length, 1)
  }
  assert.deepEqual(assigned(partition(meta, 2, heavy).parts), [['rest', 'big', 'small'], ['huge']])
})

test('the hosted core split has no rest, leaves firmware and requests to their own parts and covers the rest once', () => {
  const grown = withTargets(['firmware', 'requests', ...Object.keys(sized.targets), 'brand_new'])
  for (const count of [1, 2, 3]) {
    const plans = Array.from({ length: count }, (_, i) => commands(grown, i + 1, { of: count, weights: sized, coreOnly: true }))
    assert.deepEqual(plans.flatMap(selected).sort(), [...Object.keys(sized.targets), 'brand_new'].sort())
    for (const plan of plans) {
      assert.ok(plan.length <= 1)
      for (const args of plan) assert.deepEqual(args.slice(0, 4), ['test', '--locked', '-p', 'sx-core'])
      assert.ok(!plan.flat().some((arg) => ['--workspace', '--doc', '--lib'].includes(arg)))
    }
  }
  const { parts } = partition(grown, 2, sized, { coreOnly: true })
  assert.ok(!parts.flatMap((part) => part.items).some((item) => item.rest || item.name === 'firmware' || item.name === 'requests'))
  assert.deepEqual(assigned(parts), [['a', 'd', 'e'], ['b', 'c', 'f', 'brand_new']])
  assert.throws(() => checkPartition(['a'], [{ items: [{ name: 'rest', rest: true, weight: 1 }, { name: 'a', rest: false, weight: 1 }], load: 2 }], { coreOnly: true }), /rest in a core-only split/)
})

test('the command line takes --core-only for the hosted core split', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sx-rust-core-'))
  const file = join(dir, 'metadata.json')
  try {
    writeFileSync(file, JSON.stringify(withTargets(['firmware', 'requests', 'determinism', 'aegis'])))
    const run = (...args) => spawnSync(process.execPath, [script, ...args, '--metadata', file], { encoding: 'utf8' })
    const both = [1, 2].map((part) => JSON.parse(run(String(part), '--of', '2', '--core-only', '--plan').stdout))
    assert.deepEqual(both, [[['test', '--locked', '-p', 'sx-core', '--test', 'determinism']], [['test', '--locked', '-p', 'sx-core', '--test', 'aegis']]])
    const all = run('--of', '2', '--core-only', '--partition')
    assert.equal(all.status, 0, all.stderr)
    assert.doesNotMatch(all.stdout, /rest|firmware|requests/)
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()))
    rmSync(dir, { recursive: true, force: true })
  }
})
