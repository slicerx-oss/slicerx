// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { check, diskTargets, SPLITS } from './rust-part-coverage.mjs'

const weights = { rest: 100, targets: { firmware: 60, requests: 50, a: 40, b: 30, c: 20, d: 10 } }
const coreTests = ['firmware', 'requests', 'a', 'b', 'c', 'd']

// A small repository on disk: sx-core with six test files, sx-cli with two, and a directory test in sx-cli.
function makeRepo(extra = []) {
  const root = mkdtempSync(join(tmpdir(), 'sx-part-coverage-'))
  const put = (path) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), '')
  }
  for (const name of [...coreTests, ...extra]) put(`packages/core/tests/${name}.rs`)
  for (const name of ['cli_a', 'cli_b']) put(`packages/core/cli/tests/${name}.rs`)
  put('packages/core/cli/tests/dir_case/main.rs')
  put('packages/core/cli/tests/dir_case/helper.rs')
  mkdirSync(join(root, 'packages/core/cli/tests/not_a_test'), { recursive: true })
  const target = (name) => ({ name, kind: ['test'] })
  const metadata = {
    workspace_members: ['core', 'cli'],
    packages: [
      { id: 'core', name: 'sx-core', manifest_path: join(root, 'packages/core/Cargo.toml'), targets: coreTests.map(target) },
      { id: 'cli', name: 'sx-cli', manifest_path: join(root, 'packages/core/cli/Cargo.toml'), targets: ['cli_a', 'cli_b', 'dir_case'].map(target) },
    ],
  }
  return { root, metadata }
}

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
const cleanup = (root) => {
  assert.equal(dirname(resolve(root)), resolve(tmpdir()))
  rmSync(root, { recursive: true, force: true })
}

test('cargo finds tests/name.rs and tests/name/main.rs and nothing else', () => {
  const { root } = makeRepo()
  try {
    assert.deepEqual(diskTargets(join(root, 'packages/core/cli')), ['cli_a', 'cli_b', 'dir_case'])
    assert.deepEqual(diskTargets(join(root, 'packages/nothing')), [])
  } finally {
    cleanup(root)
  }
})

test('a complete layout has no problems and the workflow matches the splits', () => {
  const { root, metadata } = makeRepo()
  try {
    const { problems, lines } = check({ root, metadata, weights, workflow })
    assert.deepEqual(problems, [])
    assert.equal(lines.length, SPLITS.length + 1)
    assert.match(lines[0], /^macOS, 2 parts: sx-core 6 files, \d \+ \d, everything else in part 1$/)
    assert.match(lines.at(-1), /^sx-cli: 3 test files/)
  } finally {
    cleanup(root)
  }
})

test('a new test file lands in exactly one part of every split without a weight', () => {
  const { root, metadata } = makeRepo(['brand_new'])
  metadata.packages[0].targets.push({ name: 'brand_new', kind: ['test'] })
  try {
    assert.deepEqual(check({ root, metadata, weights, workflow }).problems, [])
  } finally {
    cleanup(root)
  }
})

test('a file on disk that cargo has no target for, and a target with no file, are reported', () => {
  const { root, metadata } = makeRepo(['orphan'])
  metadata.packages[1].targets.push({ name: 'ghost', kind: ['test'] })
  try {
    const { problems } = check({ root, metadata, weights, workflow })
    assert.ok(problems.some((p) => /tests\/orphan: on disk, but cargo has no test target/.test(p)), problems.join('\n'))
    assert.ok(problems.some((p) => /test target ghost has no file/.test(p)), problems.join('\n'))
  } finally {
    cleanup(root)
  }
})

test('a workflow with the wrong number of parts, the wrong --of or a second saver is reported', () => {
  const { root, metadata } = makeRepo()
  try {
    const bad = workflow
      .replace('part: [1, 2]', 'part: [1, 2, 3]')
      .replace('windows-rust-tests.mjs ${{ matrix.part }} --of 3', 'windows-rust-tests.mjs ${{ matrix.part }} --of 2')
      .replace('save-if: ${{ matrix.part == 1 }}', 'save-if: true')
    const { problems } = check({ root, metadata, weights, workflow: bad })
    assert.ok(problems.some((p) => /rust-macos-parts: the matrix has parts \[1, 2, 3\], the split has 2/.test(p)), problems.join('\n'))
    assert.ok(problems.some((p) => /rust-windows-parts: the test step must pass --of 3 once \(found 2\)/.test(p)), problems.join('\n'))
    assert.ok(problems.some((p) => /rust-macos-parts: only part 1 may save the cache/.test(p)), problems.join('\n'))
    const missing = check({ root, metadata, weights, workflow: workflow.replace('  rust-windows-parts:\n', '  rust-windows-partz:\n') })
    assert.ok(missing.problems.some((p) => /ci\.yml has no job rust-windows-parts/.test(p)), missing.problems.join('\n'))
  } finally {
    cleanup(root)
  }
})
