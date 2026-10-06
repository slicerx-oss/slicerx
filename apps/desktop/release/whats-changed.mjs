// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The "What changed" list for a release's notes: one plain line per change people will notice.
//   node apps/desktop/release/whats-changed.mjs [--since <tag>] [--json]
// Sources, both optional:
// - a commit trailer `User-note: <one line>` on a commit pushed straight to main
// - a merged pull request with the `user-facing` label: the first line under its "## For users" heading,
//   else its title (read with the gh CLI; skipped when gh is missing or signed out)
// `Reported-in: <link>` (a trailer, or a line in the pull request body) names the bug report the change fixes,
// so the release bot can reply there. --since defaults to the newest desktop-v* tag.
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { since: { type: 'string' }, json: { type: 'boolean', default: false } } })
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

const since = values.since ?? git('tag', '--list', 'desktop-v*', '--sort=-creatordate').split('\n')[0]
if (!since) throw new Error('No desktop-v* tag yet; give --since <tag or commit>.')

const SEP = '\u001e'
const notes = []
const log = git('log', `${since}..HEAD`, `--format=%h%x1f%(trailers:key=User-note,valueonly,separator=%x1d)%x1f%(trailers:key=Reported-in,valueonly,separator=%x1d)${SEP}`)
for (const rec of log.split(SEP)) {
  const [ref, note, reports] = rec.trim().split('\u001f')
  if (!ref || !note?.trim()) continue
  for (const line of note.split('\u001d').map((s) => s.trim()).filter(Boolean)) {
    notes.push({ note: line, ref, reports: (reports ?? '').split('\u001d').map((s) => s.trim()).filter(Boolean) })
  }
}

let prs = []
try {
  const date = git('log', '-1', '--format=%cI', since)
  const out = execFileSync('gh', ['pr', 'list', '--state', 'merged', '--label', 'user-facing', '--search', `merged:>${date}`, '--limit', '200', '--json', 'number,title,body,url'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  prs = JSON.parse(out)
} catch {
  console.error('whats-changed: no pull requests read (gh missing or signed out); commit trailers only')
}
for (const pr of prs) {
  const body = (pr.body ?? '').replace(/<!--[\s\S]*?-->/g, '')
  const section = body.split(/^## For users\s*$/m)[1]?.split(/^## /m)[0] ?? ''
  const note = section.split('\n').map((s) => s.replace(/^[-*]\s*/, '').trim()).find(Boolean) ?? pr.title
  const reports = [...body.matchAll(/^Reported-in:\s*(\S+)/gm)].map((m) => m[1])
  if (!notes.some((n) => n.note === note)) notes.push({ note, ref: `#${pr.number}`, url: pr.url, reports })
}

if (values.json) console.log(JSON.stringify({ since, notes }, null, 2))
else if (notes.length) console.log(['## What changed', '', ...notes.map((n) => `- ${n.note}`)].join('\n'))
else console.error(`whats-changed: nothing marked for people since ${since}`)
