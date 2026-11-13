// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { EXPECTED, staleGuard } from './creative-guard.mjs'

const script = fileURLToPath(new URL('./creative-guard.mjs', import.meta.url))
const HINGE = 'packages/mcp/evals/creative/recordings/hinge-box.json'

// The script as CI runs it, in a scratch folder holding the change's own expected-scored.json, the changed files given
// as a list (no git, no network).
function guard({ summary, expected, changed }) {
  const dir = mkdtempSync(join(tmpdir(), 'sx-creative-guard-'))
  try {
    mkdirSync(join(dir, dirname(EXPECTED)), { recursive: true })
    writeFileSync(join(dir, EXPECTED), `${JSON.stringify({ scored: expected })}\n`)
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ mode: 'replay', all: true, scored: 19, passed: 15, stale: [], broken: [], skipped: [], waiting: [], ...summary }))
    writeFileSync(join(dir, 'changed.txt'), changed.join('\n'))
    return spawnSync(process.execPath, [script, 'summary.json', '--files-from', 'changed.txt'], { cwd: dir, encoding: 'utf8' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('passes a replay that scores main\'s count or more', () => {
  assert.equal(staleGuard({ scored: 19, expected: 19, changed: [] }).ok, true)
  assert.equal(staleGuard({ scored: 20, expected: 19, changed: [] }).ok, true)
})

test('fails a replay that scores fewer than main\'s count when the change recaptures no recording, naming the stale ones', () => {
  // as hinge-box went: a pilot fix changed what a tool answers, and the replay staled a case with nothing else failing
  const v = staleGuard({ scored: 18, stale: ['gear-pair', 'hinge-box'], expected: 19, changed: ['packages/pilot/src/sheet.ts', 'packages/pilot/test/sheet.test.ts'] })
  assert.equal(v.ok, false)
  assert.match(v.message, /18 scored, under the 19 in packages\/mcp\/evals\/creative\/expected-scored\.json, and this change recaptures no recording/)
  assert.match(v.message, /Stale, so left out of the score: gear-pair, hinge-box/)
  const r = guard({ summary: { scored: 18, stale: ['gear-pair', 'hinge-box'] }, expected: 19, changed: ['packages/pilot/src/sheet.ts'] })
  assert.equal(r.status, 1, r.stderr)
  assert.match(r.stdout, /recaptures no recording/)
})

test('lets a change that recaptures a recording through, though the count moved', () => {
  assert.equal(staleGuard({ scored: 18, expected: 19, changed: [HINGE] }).ok, true)
  const r = guard({ summary: { scored: 18 }, expected: 19, changed: ['packages/pilot/src/sheet.ts', HINGE] })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /recaptures 1 recording: set the count in .* to 18/)
})

test('lets a change that lowers the expected count in the same diff through, and holds it to the new count', () => {
  // the change's own expected-scored.json is what it is held to, so lowering it in the diff is the visible way through
  const r = guard({ summary: { scored: 18 }, expected: 18, changed: ['packages/pilot/src/sheet.ts', EXPECTED] })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(guard({ summary: { scored: 17 }, expected: 18, changed: [EXPECTED] }).status, 1)
})

test('a replay fix in cad-history with no recording changed: quiet when it moves no case, held to main\'s count when it does', () => {
  // shaped like a fix to how a suppressed boolean replays: a behavior change in packages/cad-history and its test
  const fix = ['packages/cad-history/src/replay.ts', 'packages/cad-history/test/replay.test.ts']
  // (a) it moves no creative case: the same count, and nothing to say
  assert.equal(guard({ summary: { scored: 19 }, expected: 19, changed: fix }).status, 0)
  // (b) it takes a case out of the score: it fails, saying the two ways through
  const r = guard({ summary: { scored: 18, stale: ['gear-pair', 'flexi-fish'] }, expected: 19, changed: fix })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.equal(r.stdout.trim(), 'creative replay: 18 scored, under the 19 in packages/mcp/evals/creative/expected-scored.json, and this change recaptures no recording. Stale, so left out of the score: gear-pair, flexi-fish. Capture those again live (eval:creative --mode live --record), or set the count in packages/mcp/evals/creative/expected-scored.json to 18 and say why in the pull request')
  // and passes once the same diff lowers the count to what it scores
  assert.equal(guard({ summary: { scored: 18 }, expected: 18, changed: [...fix, EXPECTED] }).status, 0)
})

test('counts only a recording as a recapture, never the expected count, the eval\'s code or a nested file', () => {
  for (const f of [EXPECTED, 'packages/mcp/evals/creative/run.ts', 'packages/mcp/evals/creative/recordings/old/hinge-box.json', 'packages/app/test/fixtures/hinge-box.json']) assert.equal(staleGuard({ scored: 18, expected: 19, changed: [f] }).ok, false, f)
})

test('refuses a summary that is not a full replay with the engine built', () => {
  for (const summary of [{ mode: 'live' }, { all: false }, { skipped: ['hinge-box'] }]) assert.equal(guard({ summary, expected: 19, changed: [] }).status, 2, JSON.stringify(summary))
})
