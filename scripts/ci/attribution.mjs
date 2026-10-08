#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Fails when a commit message in the run's range, or the pull request body, carries AI attribution: a co-author
// trailer, a session trailer or link, or a "generated with" line. The hygiene job in .github/workflows/ci.yml runs it.
//
//   node scripts/ci/attribution.mjs [<revision range>]
//
// With no range it takes the commits this run is about from the GitHub environment, the way the secrets job does: a
// pull request's own commits (BASE_SHA..HEAD_SHA), the queued commits on a merge group (MQ_BASE_SHA..MQ_HEAD_SHA),
// or the commits a push added (PUSH_BEFORE..GITHUB_SHA, or GITHUB_SHA alone for a new branch). PR_BODY, when set, is
// checked too. Exits 1 on a hit, 2 when there is no range to check.
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** What counts as AI attribution, matched line by line without regard to case. The one list for commits and bodies. */
export const patterns = [
  /co-authored-by:\s*claude/i,
  /generated with \[?claude/i,
  /claude-session/i,
  /noreply@anthropic/i,
  /claude\.ai\/(code|share|chat)\b/i,
]

/** The lines of a text that match a pattern. */
export function hits(text) {
  return text.split(/\r?\n/).filter((line) => patterns.some((re) => re.test(line)))
}

/** The git log arguments for the commits a run is about, from its environment, or null when it names none. */
export function range(env) {
  const zero = /^0+$/
  if (env.GITHUB_EVENT_NAME === 'pull_request') return env.BASE_SHA && env.HEAD_SHA ? [`${env.BASE_SHA}..${env.HEAD_SHA}`] : null
  if (env.GITHUB_EVENT_NAME === 'merge_group') return env.MQ_BASE_SHA && env.MQ_HEAD_SHA ? [`${env.MQ_BASE_SHA}..${env.MQ_HEAD_SHA}`] : null
  if (!env.GITHUB_SHA) return null
  return env.PUSH_BEFORE && !zero.test(env.PUSH_BEFORE) ? [`${env.PUSH_BEFORE}..${env.GITHUB_SHA}`] : ['-1', env.GITHUB_SHA]
}

/** Each commit in a range with its full message. */
function commits(args) {
  const out = execFileSync('git', ['log', '--format=%h%x00%B%x1e', ...args, '--'], { encoding: 'utf8', maxBuffer: 64 << 20 })
  return out
    .split('\x1e')
    .map((entry) => entry.replace(/^\n/, ''))
    .filter(Boolean)
    .map((entry) => {
      const [sha, message] = entry.split('\x00')
      return { sha, message }
    })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv[2] ? [process.argv[2]] : range(process.env)
  if (!args) {
    console.error('usage: attribution.mjs [<revision range>] (or the GitHub event environment, see the header)')
    process.exit(2)
  }
  let list
  try {
    list = commits(args)
  } catch (e) {
    console.error(`attribution: cannot read the commits in ${args.join(' ')}: ${e.message.split('\n')[0]}`)
    process.exit(2)
  }
  let found = 0
  for (const { sha, message } of list) {
    for (const line of hits(message)) {
      found++
      console.log(`commit ${sha}: ${line.trim()}`)
    }
  }
  const body = process.env.PR_BODY ?? ''
  for (const line of hits(body)) {
    found++
    console.log(`pull request body: ${line.trim()}`)
  }
  const where = `${list.length} commit(s) in ${args.join(' ')}${body ? ' and the pull request body' : ''}`
  if (found) {
    console.error(`attribution: ${found} line(s) of AI attribution in ${where}`)
    process.exit(1)
  }
  console.log(`attribution: none in ${where}`)
}
