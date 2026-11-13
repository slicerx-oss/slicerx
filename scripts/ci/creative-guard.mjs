// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Fails when the creative replay scores fewer recordings than main's count and the change recaptures none. A recording
// the replay marks stale is left out of the score, so a change that moves what a tool answers can drop a case from the
// score with nothing failing (a refused sheet that is now accepted staled hinge-box that way). Main's count is the one
// committed in packages/mcp/evals/creative/expected-scored.json: a change that leaves that file alone is held to main's
// number, with no network call. Two ways through, both in the diff where review sees them: recapture the recordings
// (a changed file under evals/creative/recordings), or lower the count in expected-scored.json and say why in the pull
// request. Nothing else is compared: a case moving from pass to fail is the replay's own report, not this check's.
//
//   node scripts/ci/creative-guard.mjs <summary.json> <base>   the summary eval:creative --summary wrote, and the
//                                                              commit the change is diffed against
//   add --files-from <file> (or - for stdin) to read the changed files from a list instead of git diff
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const EXPECTED = 'packages/mcp/evals/creative/expected-scored.json'
const RECORDING = /^packages\/mcp\/evals\/creative\/recordings\/[^/]+\.json$/

/**
 * The verdict for a full creative replay: `scored` and `stale` from its summary, `expected` the committed count (this
 * change's own file, which is main's unless the change edits it), `changed` the files the change touches.
 */
export function staleGuard({ scored, stale = [], expected, changed }) {
  const recaptured = changed.filter((f) => RECORDING.test(f))
  if (scored >= expected) return { ok: true, message: `creative replay: ${scored} scored, at least the ${expected} in ${EXPECTED}` }
  if (recaptured.length) return { ok: true, message: `creative replay: ${scored} scored, under the ${expected} in ${EXPECTED}, and this change recaptures ${recaptured.length} recording${recaptured.length === 1 ? '' : 's'}: set the count in ${EXPECTED} to ${scored} if that is the new count` }
  return {
    ok: false,
    message: `creative replay: ${scored} scored, under the ${expected} in ${EXPECTED}, and this change recaptures no recording${stale.length ? `. Stale, so left out of the score: ${stale.join(', ')}` : ''}. Capture those again live (eval:creative --mode live --record), or set the count in ${EXPECTED} to ${scored} and say why in the pull request`,
  }
}

function changedFiles(base, from) {
  if (from) return readFileSync(from === '-' ? 0 : from, 'utf8').split(/\r?\n/).filter(Boolean)
  return execFileSync('git', ['diff', '--name-only', base, 'HEAD'], { encoding: 'utf8' }).split('\n').filter(Boolean)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [file, base] = process.argv.slice(2).filter((a, i, all) => a !== '--files-from' && all[i - 1] !== '--files-from')
  const at = process.argv.indexOf('--files-from')
  const from = at >= 0 ? process.argv[at + 1] : undefined
  if (!file || (!base && !from)) {
    console.error('usage: node scripts/ci/creative-guard.mjs <summary.json> <base> [--files-from file|-]')
    process.exit(2)
  }
  const s = JSON.parse(readFileSync(file, 'utf8'))
  // a partial run or one with no engine says nothing about the count
  if (s.mode !== 'replay' || !s.all || s.skipped?.length) {
    console.error(`creative-guard: ${file} is not a full replay with the engine built (mode ${s.mode}, all ${s.all}, ${s.skipped?.length ?? 0} skipped)`)
    process.exit(2)
  }
  const expected = JSON.parse(readFileSync(EXPECTED, 'utf8')).scored
  const v = staleGuard({ scored: s.scored, stale: s.stale, expected, changed: changedFiles(base, from) })
  console.log(v.message)
  process.exit(v.ok ? 0 : 1)
}
