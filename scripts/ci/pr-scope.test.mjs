// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { chromiumPackages, crateReads, enginePackages, jobs, packageReaders, replayPackages, testPatterns, tree, web, webArgs } from './pr-scope.mjs'
import { root } from '../test-affected.mjs'

// A pull request's jobs come from scripts/ci/pr-scope.mjs, read against the real tree, so a new crate, package or path
// read is covered without an edit here. These tests hold the rules that keep a skip from letting a break through: what
// runs for each kind of change, the lists the web job reads, and the workflow lines that use the results.
const t = tree()
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
const required = readFileSync(new URL('./required-checks.txt', import.meta.url), 'utf8').split(/\r?\n/).filter((s) => s && !s.startsWith('#'))
const run = (files) => { const j = jobs(files, t); return { rust: j.rust, wasm: j.wasm, bridge: j.bridge, web: j.web } }
const grep = (pattern, ...paths) => {
  try {
    return execFileSync('git', ['grep', '-l', '-E', pattern, '--', ...paths], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
  } catch { return [] }
}
const pkgOf = (f) => [...t.pkgs.values()].filter((p) => f.startsWith(`${p.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0]

test('a test file of one package runs no Rust job and tests that package only', () => {
  assert.deepEqual(run(['packages/mcp/test/agents.test.ts']), { rust: false, wasm: false, bridge: false, web: 'changed' })
  const args = webArgs(['packages/mcp/test/agents.test.ts'], 'BASE', t)
  assert.deepEqual(args.slice(0, 2), ['--filter', '...[BASE]'])
  for (const p of testPatterns) assert.ok(args.includes(p))
})

test('an app source file runs the web build but no Rust job', () => {
  assert.deepEqual(run(['packages/app/src/index.ts']), { rust: false, wasm: true, bridge: false, web: 'changed' })
})

test('a Rust source file runs every Rust job, and tests every package (it is outside them all)', () => {
  assert.deepEqual(run(['packages/geom/src/array.rs']), { rust: true, wasm: true, bridge: true, web: 'all' })
  assert.deepEqual(run(['packages/core/src/lib.rs']), { rust: true, wasm: true, bridge: true, web: 'all' })
})

test('shared inputs run everything', () => {
  for (const f of ['.github/workflows/ci.yml', 'scripts/ci/pr-test.sh', 'Cargo.lock', 'Cargo.toml', 'rust-toolchain.toml']) {
    assert.deepEqual(run([f]), { rust: true, wasm: true, bridge: true, web: 'all' }, f)
  }
  for (const f of ['pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml', 'tsconfig.base.json', '.nvmrc', 'docs/testing.md', 'knowledge/settings.yaml']) {
    const j = run([f])
    assert.equal(j.web, 'all', f)
    assert.equal(j.wasm, true, f)
  }
})

test('the desktop shell crate runs desktop-bridge and rust, and tests its package and its readers', () => {
  assert.deepEqual(run(['apps/desktop/src-tauri/src/main.rs']), { rust: true, wasm: false, bridge: true, web: 'changed' })
  assert.equal(run(['apps/desktop/release/check-agent-bridge.mjs']).bridge, true)
  // the MCP server's tests read the shell's sources (test/open-in-app.test.ts)
  assert.ok(webArgs(['apps/desktop/src-tauri/src/opened.rs'], 'BASE', t).includes('@slicerx/mcp'))
})

test('a TypeScript file a crate reads runs the rust job', () => {
  const reads = crateReads(t)
  // build.rs reads the viewport's head shapes; sx-settings reads the contract fixtures
  assert.ok([...reads.get('packages/core')].some((p) => p.startsWith('packages/ui/viewport/data')))
  assert.ok([...reads.get('packages/settings')].includes('packages/contracts/fixtures'))
  const fixture = t.files.find((f) => f.startsWith('packages/contracts/fixtures/'))
  assert.ok(fixture)
  assert.equal(run([fixture]).rust, true)
  assert.equal(run(['packages/ui/viewport/data/head-shapes.json']).rust, true)
})

test('a package whose files another package reads by path also tests the reader', () => {
  const readers = packageReaders(t)
  // the app's tests read the cloud scan's fixtures and the cloud package does not depend on the app
  assert.ok(readers.get('editions/slicerx/packages/cloud')?.has('packages/app'))
  const args = webArgs(['editions/slicerx/packages/cloud/test/mock-service.ts'], 'BASE', t)
  assert.ok(args.includes('@slicerx/app'))
  assert.ok(args.includes('@slicerx/mcp'))
})

test('no file imports a test file, so a test-only change can leave the dependents out', () => {
  const files = grep(String.raw`from '[^']*\.(test|spec)(\.[cm]?[jt]sx?)?'`, '*.ts', '*.tsx', '*.mts', '*.mjs', '*.js')
  assert.deepEqual(files, [])
})

test('the engine and Chromium lists cover every package that needs them', () => {
  const engineUsers = new Set(grep('sx_geom_wasm', 'packages', 'editions', 'apps')
    .filter((f) => !f.startsWith('apps/web/') && !/\/(src|scripts|wasm)\//.test(f) && !f.endsWith('.md'))
    .map((f) => pkgOf(f)?.name).filter(Boolean))
  for (const n of engineUsers) assert.ok(enginePackages.includes(n) || replayPackages.includes(n), `${n} reads the engine; add it to enginePackages or replayPackages`)
  const browserUsers = new Set(grep(String.raw`chromium|from '(playwright|@playwright/test)'`, '*.test.ts', '*.test.tsx', '*.test.mjs')
    .filter((f) => !f.startsWith('apps/web/e2e/') && !f.startsWith('scripts/'))
    .map((f) => pkgOf(f)?.name).filter(Boolean))
  for (const n of browserUsers) assert.ok(chromiumPackages.includes(n), `${n} has browser tests; add it to chromiumPackages`)
  assert.deepEqual(web(['@slicerx/mcp']), { packages: ['@slicerx/mcp'], engine: false, chromium: false })
  assert.deepEqual(web(['@slicerx/app', '@slicerx/ui']), { packages: ['@slicerx/app', '@slicerx/ui'], engine: true, chromium: true })
})

// The text of one top-level job, from its "  id:" line to the next job.
function job(id) {
  const lines = workflow.split(/\r?\n/)
  const start = lines.indexOf(`  ${id}:`)
  assert.ok(start >= 0, `ci.yml has no job ${id}`)
  let end = start + 1
  while (end < lines.length && !/^ {2}\S/.test(lines[end])) end++
  return lines.slice(start, end).join('\n')
}
const jobIf = (text) => (/^ {4}if: (.*)$/m.exec(text) || [])[1] ?? ''

test('the workflow asks only on a pull request without full-ci, and runs everything when the script fails', () => {
  const d = job('detect')
  for (const o of ['rust_changed', 'wasm_changed', 'bridge_changed', 'web_tests']) assert.match(d, new RegExp(`^ {6}${o}: \\$\\{\\{ steps\\.f\\.outputs\\.${o} \\}\\}$`, 'm'))
  assert.match(d, /scope=\$\(printf 'rust=true\\nwasm=true\\nbridge=true\\nweb=all'\)/)
  assert.match(d, /if \[ "\$GITHUB_EVENT_NAME" = pull_request \] && \[ "\$FULL_CI" != true \]; then\n\s+if out=\$\(node scripts\/ci\/pr-scope\.mjs jobs HEAD\^1 HEAD\); then scope=\$out/)
})

test('the rust job never skips at job level for the scope, so its required matrix name reports', () => {
  const r = job('rust')
  assert.doesNotMatch(jobIf(r), /rust_changed/)
  assert.match(r, /DUP: >-\n\s+\$\{\{ .*needs\.detect\.outputs\.rust_changed == 'false' \}\}/)
  assert.ok(required.includes('rust (ubuntu-latest)'))
})

test('wasm still runs whenever a browser job needs its modules', () => {
  const w = jobIf(job('wasm'))
  assert.match(w, /needs\.detect\.outputs\.wasm_changed != 'false' \|\| needs\.detect\.outputs\.e2e == 'true' \|\| needs\.detect\.outputs\.smoke == 'true'/)
  for (const id of ['e2e-shard', 'e2e-smoke', 'e2e-gpu']) assert.match(job(id), /needs: \[detect, wasm,/)
  assert.ok(required.includes('wasm'))
  assert.match(jobIf(job('desktop-bridge')), /needs\.detect\.outputs\.bridge_changed != 'false'/)
})

test('the web job tests everything unless the scope step says otherwise', () => {
  const w = job('web')
  assert.match(w, /if \[ "\$ALL" != false \] \|\| \[ \$\{#filters\[@\]\} -eq 0 \]; then/)
  assert.match(w, /printf 'all=true\\nengine=true\\nchromium=true\\n'/)
  assert.match(w, /node scripts\/ci\/pr-scope\.mjs web HEAD\^1/)
  for (const step of ['run: pnpm lint', 'run: pnpm typecheck', 'run: pnpm test:scripts']) assert.ok(w.includes(`- ${step}`), step)
  assert.ok(required.includes('web'))
})

// One step's run script from a job's text, indentation removed: the step that starts with the line holding `marker`
// (`- id: scope`), or the step whose `run: |` block holds it.
function stepScript(text, marker) {
  const lines = text.split('\n')
  const isRun = (l) => /^( {6}- | {8})run: \|$/.test(l)
  let at = lines.findIndex((l) => l.includes(marker))
  assert.ok(at >= 0, `no step line with ${marker}`)
  if (/^ {6}- /.test(lines[at])) {
    do at++
    while (at < lines.length && !isRun(lines[at]) && !/^ {6}- /.test(lines[at]))
  } else {
    while (at >= 0 && !isRun(lines[at])) at--
  }
  assert.ok(at >= 0 && at < lines.length && isRun(lines[at]), `no run script for ${marker}`)
  const body = []
  for (let i = at + 1; i < lines.length && (/^ {10}/.test(lines[i]) || lines[i] === ''); i++) body.push(lines[i].slice(10))
  return body.join('\n')
}

// Runs a step script with stand-ins for node (printing NODE_OUT, or failing when it is unset) and pnpm (logging its
// arguments), and returns the step's outputs, its log and what pnpm was asked to do.
function runStep(script, env) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-scope-'))
  const stub = (name, body) => { writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(dir, name), 0o755) }
  stub('node', '[ -n "${NODE_OUT+x}" ] || exit 1\nprintf \'%s\\n\' "$NODE_OUT"')
  stub('pnpm', 'printf \'%s\\n\' "$*" >> "$PNPM_LOG"')
  const out = join(dir, 'output')
  const log = join(dir, 'pnpm.log')
  writeFileSync(out, '')
  writeFileSync(log, '')
  const r = spawnSync(bash, ['-eo', 'pipefail', '-c', script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, GITHUB_OUTPUT: out, PNPM_LOG: log, GITHUB_WORKSPACE: '/w', ...env },
  })
  const res = { status: r.status, stdout: r.stdout, output: readFileSync(out, 'utf8'), pnpm: readFileSync(log, 'utf8').trim() }
  rmSync(dir, { recursive: true, force: true })
  return res
}

test('an empty package list or a failed script tests every package, with a warning', () => {
  const scope = stepScript(job('web'), '- id: scope')
  const pr = { GITHUB_EVENT_NAME: 'pull_request', WEB_TESTS: 'changed' }
  const named = runStep(scope, { ...pr, NODE_OUT: 'packages=@slicerx/mcp\nengine=false\nchromium=false' })
  assert.match(named.output, /^packages=@slicerx\/mcp$/m)
  assert.match(named.output, /^all=false$/m)
  for (const env of [{ NODE_OUT: 'packages=\nengine=false\nchromium=false' }, { NODE_OUT: 'packages= \nengine=false\nchromium=false' }, {}]) {
    const r = runStep(scope, { ...pr, ...env })
    assert.equal(r.status, 0)
    assert.match(r.output, /all=true\nengine=true\nchromium=true/)
    assert.doesNotMatch(r.output, /all=false/)
    assert.match(r.stdout, /::warning title=Web test scope::/)
  }
  // a merge queue run never asks
  assert.match(runStep(scope, { GITHUB_EVENT_NAME: 'merge_group', WEB_TESTS: '' }).output, /all=true/)

  const tests = stepScript(job('web'), 'for p in $PACKAGES')
  assert.equal(runStep(tests, { ALL: 'false', PACKAGES: '@slicerx/contracts @slicerx/mcp' }).pnpm, '--filter @slicerx/contracts --filter @slicerx/mcp exec bash /w/scripts/ci/pr-test.sh')
  assert.equal(runStep(tests, { ALL: 'true', PACKAGES: '' }).pnpm, '-r exec bash /w/scripts/ci/pr-test.sh')
  const empty = runStep(tests, { ALL: 'false', PACKAGES: '' })
  assert.equal(empty.pnpm, '-r exec bash /w/scripts/ci/pr-test.sh')
  assert.match(empty.stdout, /::warning title=Web test scope::/)
})
