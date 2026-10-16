// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs test-affected.mjs on a small repository: packages, crates and journeys of its own, so the plan for a set of
// changed files can be checked line by line.
// Usage: node --test scripts/test-affected.test.mjs (pnpm test:scripts)
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { crates, e2ePort, loadJourneys, nodePackages, plan } from './test-affected.mjs'

const script = join(dirname(fileURLToPath(import.meta.url)), 'test-affected.mjs')
const dirs = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

const pkg = (name, test, deps = {}) => JSON.stringify({ name, scripts: test ? { test } : {}, dependencies: deps })
const fixture = {
  'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n  - "packages/*"\n',
  'apps/web/package.json': pkg('@x/web', '', { '@x/app': 'workspace:*' }),
  'apps/web/e2e/fixtures.ts': '',
  'apps/web/e2e/journeys/lib/slice.ts': 'export const s = 1\n',
  'apps/web/e2e/journeys/slicing.spec.ts': "import { s } from './lib/slice'\n",
  'apps/web/e2e/journeys/plates.spec.ts': '',
  'apps/web/e2e/journeys/phone-plates.spec.ts': '',
  'apps/web/e2e/journeys/affected.mjs': [
    "export const smoke = ['packages/app/src/app.tsx', 'packages/app/src/state/']",
    'export const journeys = [',
    "  { paths: ['packages/app/src/plate/'], journeys: ['plates', 'phone-plates'] },",
    "  { paths: ['packages/app/src/plate/slice-'], journeys: ['slicing'] },",
    "  { paths: ['packages/app/src/state/plate-'], journeys: ['plates'] },",
    "  { paths: ['packages/app/src/gone/'], journeys: ['renamed'] },",
    ']',
  ].join('\n'),
  'packages/app/package.json': pkg('@x/app', 'vitest run', { '@x/ui': 'workspace:*' }),
  'packages/app/src/plate/arrange.ts': '',
  'packages/app/src/plate/slice-button.tsx': '',
  'packages/app/src/state/plate-store.ts': '',
  'packages/app/src/state/prefs.ts': '',
  'packages/app/src/other.ts': '',
  'packages/app/test/arrange.test.ts': '',
  'packages/ui/package.json': pkg('@x/ui', 'vitest run'),
  'packages/ui/src/button.tsx': '',
  'packages/sim/package.json': pkg('@x/sim', 'node --test src/sim.test.ts', { '@x/ui': 'workspace:*' }),
  'packages/sim/src/sim.ts': '',
  'Cargo.toml': [
    '[workspace]',
    'members = ["packages/core", "packages/core/cli", "packages/geom"]',
    '[workspace.dependencies]',
    'x-core = { path = "packages/core" }',
  ].join('\n'),
  'packages/core/Cargo.toml': '[package]\nname = "sx-core"\n[dependencies]\nfork = { path = "../vendor/fork" }\n',
  'packages/core/src/lib.rs': '',
  'packages/core/tests/firmware.rs': '',
  'packages/core/tests/reference.rs': '',
  'packages/core/tests/requests.rs': '',
  'packages/core/cli/Cargo.toml': '[package]\nname = "x-cli"\n[[bin]]\npath = "src/main.rs"\n[dependencies]\nx-core.workspace = true\n',
  'packages/core/cli/src/main.rs': '',
  'packages/geom/Cargo.toml': '[package]\nname = "x-geom"\n[dependencies]\nfork = { path = "../vendor/fork" }\n',
  'packages/geom/src/lib.rs': '',
  'packages/vendor/fork/Cargo.toml': '[package]\nname = "fork"\n',
  'packages/vendor/fork/src/lib.rs': '',
  'scripts/check.mjs': '',
  'scripts/check.test.mjs': '',
  'scripts/lone.mjs': '',
}

function repo(files = fixture) {
  const dir = mkdtempSync(join(tmpdir(), 'test-affected-'))
  dirs.push(dir)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

const base = repo()
const ctx = { base, pkgs: nodePackages(base), rust: crates(base), journeys: await loadJourneys(base) }
const cmds = (files, extra = {}) => {
  const p = plan(files, { ...ctx, ...extra })
  return { ...p, vitest: p.vitest.map((v) => v.cmd.join(' ')), cargo: p.cargo.map((c) => c.cmd.join(' ')), playwright: p.playwright.map((x) => x.args.join(' ')) }
}

test('a source file runs its related tests in its package and in the packages that depend on it', () => {
  const p = cmds(['packages/ui/src/button.tsx'])
  assert.deepEqual(p.vitest.sort(), [
    'pnpm --filter @x/app exec vitest related --run ../ui/src/button.tsx',
    'pnpm --filter @x/sim test',
    'pnpm --filter @x/ui exec vitest related --run src/button.tsx',
  ])
  assert.deepEqual(p.cargo, [])
})

test('a test file runs in its own package only, and a deleted source runs the whole package', () => {
  assert.deepEqual(cmds(['packages/app/test/arrange.test.ts']).vitest, ['pnpm --filter @x/app exec vitest related --run test/arrange.test.ts'])
  assert.deepEqual(cmds(['packages/ui/src/removed.tsx']).vitest, ['pnpm --filter @x/ui exec vitest run'])
})

test('a script runs the test beside it, and a script with none runs nothing', () => {
  assert.deepEqual(cmds(['scripts/check.mjs']).vitest, ['node --test scripts/check.test.mjs'])
  assert.deepEqual(cmds(['scripts/lone.mjs']).vitest, [])
})

test('a crate change tests that crate without its slow binaries and compile-checks its dependents', () => {
  const p = cmds(['packages/core/src/lib.rs'])
  assert.deepEqual(p.cargo, ['cargo test -p sx-core --lib --bins --test reference', 'cargo check --tests -p x-cli'])
  assert.match(p.notes.join('\n'), /leaves out firmware, requests/)
  assert.deepEqual(cmds(['packages/core/src/lib.rs'], { slow: true }).cargo, ['cargo test -p sx-core', 'cargo check --tests -p x-cli'])
})

test('a change to one integration test runs that test binary alone, even a slow one', () => {
  assert.deepEqual(cmds(['packages/core/tests/firmware.rs']).cargo, ['cargo test -p sx-core --test firmware'])
})

test('a vendored fork tests the members that build it', () => {
  const p = cmds(['packages/vendor/fork/src/lib.rs'])
  assert.deepEqual(p.cargo, ['cargo test -p sx-core --lib --bins --test reference', 'cargo test -p x-geom', 'cargo check --tests -p x-cli'])
})

test('source maps to journeys by the longest matching prefix, with the phone project only for phone journeys', () => {
  assert.deepEqual(cmds(['packages/app/src/plate/arrange.ts']).playwright, [
    'playwright test e2e/journeys/phone-plates.spec.ts e2e/journeys/plates.spec.ts --project=desktop --project=phone',
  ])
  assert.deepEqual(cmds(['packages/app/src/plate/slice-button.tsx']).playwright, ['playwright test e2e/journeys/slicing.spec.ts --project=desktop'])
  assert.deepEqual(cmds(['packages/app/src/state/plate-store.ts']).playwright, ['playwright test e2e/journeys/plates.spec.ts --project=desktop'])
})

test('a smoke row, or app source no row names, runs the @smoke tests', () => {
  const smoke = 'playwright test e2e/journeys --grep @smoke --project=desktop'
  assert.deepEqual(cmds(['packages/app/src/state/prefs.ts']).playwright, [smoke])
  assert.deepEqual(cmds(['packages/app/src/other.ts']).playwright, [smoke])
  assert.deepEqual(cmds(['packages/core/src/lib.rs']).playwright, [])
  assert.deepEqual(cmds(['packages/app/test/arrange.test.ts']).playwright, [])
})

test('a changed spec runs as it is, a helper runs the specs that import it, and a harness change runs @smoke', () => {
  assert.deepEqual(cmds(['apps/web/e2e/journeys/plates.spec.ts']).playwright, ['playwright test e2e/journeys/plates.spec.ts --project=desktop'])
  assert.deepEqual(cmds(['apps/web/e2e/journeys/lib/slice.ts']).playwright, ['playwright test e2e/journeys/slicing.spec.ts --project=desktop'])
  const h = cmds(['apps/web/e2e/fixtures.ts'])
  assert.deepEqual(h.playwright, ['playwright test e2e/journeys --grep @smoke --project=desktop'])
  assert.match(h.notes.join('\n'), /harness changed/)
})

test('a table row that names a missing journey is reported', () => {
  assert.match(cmds(['packages/app/src/gone/x.ts']).notes.join('\n'), /does not have: renamed/)
})

test('docs alone plan nothing, and a lockfile says CI covers the rest', () => {
  const d = cmds(['docs/a.md', 'packages/app/README.md'])
  assert.deepEqual([d.vitest, d.cargo, d.playwright], [[], [], []])
  assert.match(cmds(['pnpm-lock.yaml']).notes.join('\n'), /lockfile/)
})

test('the e2e port is stable for a path and never one the shared machines use', () => {
  assert.equal(e2ePort('/a/b'), e2ePort('/a/b'))
  for (const p of ['/x', '/y/z', '/builds/wt-1', '/builds/wt-2']) {
    const port = e2ePort(p)
    assert.ok(port >= 5300 && port < 5910, `${port}`)
    assert.ok(![4317, 4417, 4418, 4717, 4817, 4917, 5017, 5117].includes(port))
  }
})

test('the command line plans from git: committed, changed and untracked files since the merge base', () => {
  const dir = repo({ 'a.txt': 'a\n' })
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-qm', 'base')
  git('checkout', '-qb', 'work')
  writeFileSync(join(dir, 'b.md'), 'b\n')
  git('add', 'b.md')
  git('commit', '-qm', 'b')
  writeFileSync(join(dir, 'a.txt'), 'changed\n')
  writeFileSync(join(dir, 'c.md'), 'new\n')
  // The script reads the repository it sits in, so it runs from a copy inside the temporary one.
  mkdirSync(join(dir, 'scripts'))
  copyFileSync(script, join(dir, 'scripts/test-affected.mjs'))
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n')
  writeFileSync(join(dir, 'Cargo.toml'), '[workspace]\nmembers = []\n')
  const r = spawnSync(process.execPath, [join(dir, 'scripts/test-affected.mjs'), 'main', '--json'], { cwd: dir, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.base, 'main')
  assert.deepEqual(out.files, ['Cargo.toml', 'a.txt', 'b.md', 'c.md', 'pnpm-workspace.yaml', 'scripts/test-affected.mjs'])
})
