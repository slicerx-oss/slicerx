// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// The B-rep build on Linux is a required check through the gate job "brep (ubuntu-latest)" in ci.yml; macOS and
// Windows stay advisory. These tests read the workflow as text (the repo has no YAML parser at this level) and run the
// gate's own script, so a change to the job graph or the script that would let a red build through, or block a pull
// request the path filter skips, fails here first.
const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
const required = readFileSync(new URL('./required-checks.txt', import.meta.url), 'utf8').split(/\r?\n/).filter((s) => s && !s.startsWith('#'))
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'

// The text of one top-level job, from its "  id:" line to the next job (comments above the next job excluded).
function job(id) {
  const lines = workflow.split(/\r?\n/)
  const start = lines.indexOf(`  ${id}:`)
  assert.ok(start >= 0, `ci.yml has no job ${id}`)
  let end = start + 1
  while (end < lines.length && !/^ {2}\S/.test(lines[end])) end++
  return lines.slice(start, end).join('\n')
}
const field = (text, key) => (new RegExp(`^ {4}${key}: (.*)$`, 'm').exec(text) || [])[1]
const needs = (text) => {
  const v = field(text, 'needs')
  return v.startsWith('[') ? v.slice(1, -1).split(',').map((s) => s.trim()) : [v.trim()]
}

// The gate's run script and the env keys its step sets, from the job text.
function gateScript() {
  const lines = job('brep-gate').split('\n')
  const at = lines.findIndex((l) => /^ {8}run: \|$/.test(l))
  assert.ok(at > 0, 'the gate has one run: | step')
  const body = []
  for (let i = at + 1; i < lines.length && (/^ {10}/.test(lines[i]) || lines[i] === ''); i++) body.push(lines[i].slice(10))
  const env = lines.slice(0, at).filter((l) => /^ {10}[A-Z_]+: /.test(l)).map((l) => l.trim().split(':')[0])
  return { script: body.join('\n'), env }
}
function gate(env) {
  const { script } = gateScript()
  const r = spawnSync(bash, ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } })
  return r.status
}

test('the Linux B-rep build has a gate under the required name, needing only detect and the Linux job', () => {
  const g = job('brep-gate')
  assert.equal(field(g, 'name'), 'brep (ubuntu-latest)')
  assert.deepEqual(needs(g).sort(), ['brep-linux', 'detect'])
  // it runs whatever the build's result (failed or skipped), so a skip or a failure always reports under this name
  assert.match(field(g, 'if'), /^\$\{\{ !cancelled\(\) && /)
  assert.ok(required.includes('brep (ubuntu-latest)'), 'required-checks.txt lists the gate')
  const { env } = gateScript()
  assert.deepEqual(env.sort(), ['DETECT', 'LINUX', 'WANTED'])
  assert.match(g, /LINUX: \$\{\{ needs\.brep-linux\.result \}\}/)
})

test('the gate wants the build exactly when the Linux job runs', () => {
  const linux = job('brep-linux')
  const cond = field(linux, 'if')
  assert.equal(field(linux, 'runs-on'), 'ubuntu-latest')
  assert.match(job('brep-gate'), new RegExp(`WANTED: \\$\\{\\{ ${cond.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\}\\}`))
})

test('macOS and Windows stay advisory and out of the gate', () => {
  const adv = job('brep')
  assert.match(adv, /os: \[macos-latest, windows-latest\]/)
  assert.ok(!needs(job('brep-gate')).includes('brep'))
  for (const name of ['brep (macos-latest)', 'brep (windows-latest)', 'brep']) assert.ok(!required.includes(name), `${name} is not required`)
  // a failure says it is advisory
  assert.match(adv, /if: failure\(\)\n\s+run: \|[\s\S]*::warning title=B-rep failed on \$RUNNER_OS \(advisory\)::/)
  // no other job waits on the advisory one
  for (const m of workflow.matchAll(/^ {4}needs: (.*)$/gm)) assert.doesNotMatch(m[1], /(^|[\s[,])brep([\s\],]|$)/, `a job needs the advisory brep: ${m[1]}`)
})

test('the Linux job runs the same build and tests as the other systems', () => {
  const linux = job('brep-linux')
  for (const cmd of [
    'node --test packages/brep/tests/solids-wasm.mjs',
    'sh packages/brep/tests/wasm-cache.sh',
    'cargo clippy -p sx-brep --release --all-targets --features routine-probe -- -D warnings',
    'cargo test -p sx-brep --release --features routine-probe',
    'cargo clippy -p sx-geom --release --features brep --tests -- -D warnings',
    'cargo test -p sx-geom --release --features brep --test brep_parity --test brep_input',
  ]) {
    assert.ok(linux.includes(`- run: ${cmd}`), `brep-linux runs ${cmd}`)
    assert.ok(job('brep').includes(cmd), `brep runs ${cmd}`)
  }
  assert.match(linux, /SX_BREP_REQUIRE: '1'/)
})

test('the gate script passes on a skip and fails a wanted build that did not pass', () => {
  // the path filter skipped it, or a push the queue already tested skipped it
  assert.equal(gate({ DETECT: 'success', WANTED: 'false', LINUX: 'skipped' }), 0)
  // wanted and passed
  assert.equal(gate({ DETECT: 'success', WANTED: 'true', LINUX: 'success' }), 0)
  // wanted and failed, timed out (cancelled) or never ran
  for (const LINUX of ['failure', 'cancelled', 'skipped', '']) assert.notEqual(gate({ DETECT: 'success', WANTED: 'true', LINUX }), 0, LINUX)
  // detect did not pass: its outputs are empty, so the build was skipped for no reason, and that must not pass
  for (const DETECT of ['failure', 'cancelled', 'skipped']) assert.notEqual(gate({ DETECT, WANTED: 'false', LINUX: 'skipped' }), 0, DETECT)
})
