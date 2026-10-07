// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The "What changed" list for a release's notes: one plain line per change people will notice.
//   node apps/desktop/release/whats-changed.mjs [--since <tag>] [--to <commit>] [--json]
// Sources, both optional:
// - a commit trailer `User-note: <one line>` on a commit pushed straight to main
// - a merged pull request with the `user-facing` label: the first line under its "## For users" heading,
//   else its title (read with the gh CLI; skipped when gh is missing or signed out)
// `Reported-in: <link>` (a trailer, or a line in the pull request body) names the bug report the change fixes,
// so the release bot can reply there. `Urgent: <why people must update>` (a trailer, or a pull request with the
// `urgent` label and the same line in its body) marks a hotfix: the release notes ask everyone to update and the
// bot pings for it. Everything else is announced without a ping. `User-note-replaces: <commit>` drops the User-note of an
// earlier commit that said something wrong, so a shared branch corrects a note without rewriting history; the new
// commit's own User-note takes its place. --since defaults to the newest desktop-v* tag, --to to HEAD.
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: { since: { type: 'string' }, to: { type: 'string', default: 'HEAD' }, json: { type: 'boolean', default: false } } })
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()

const since = values.since ?? git('tag', '--list', 'desktop-v*', '--sort=-creatordate').split('\n')[0]
if (!since) throw new Error('No desktop-v* tag yet; give --since <tag or commit>.')

const SEP = '\u001e'
const notes = []
const urgent = []
const log = git('log', `${since}..${values.to}`, `--format=%H%x1f%h%x1f%(trailers:key=User-note,valueonly,separator=%x1d)%x1f%(trailers:key=Reported-in,valueonly,separator=%x1d)%x1f%(trailers:key=Urgent,valueonly,separator=%x1d)%x1f%(trailers:key=User-note-replaces,valueonly,separator=%x1d)${SEP}`)
const records = log.split(SEP).map((rec) => rec.trim().split('\u001f'))
const replaced = records.flatMap(([, , , , , gone]) => (gone ?? '').split('\u001d').map((s) => s.trim().toLowerCase()).filter((s) => /^[0-9a-f]{7,40}$/.test(s)))
for (const [full, ref, note, reports, why] of records) {
  for (const line of (why ?? '').split('\u001d').map((s) => s.trim()).filter(Boolean)) urgent.push({ why: line, ref })
  if (!ref || !note?.trim() || replaced.some((h) => full?.startsWith(h))) continue
  for (const line of note.split('\u001d').map((s) => s.trim()).filter(Boolean)) {
    notes.push({ note: line, ref, reports: (reports ?? '').split('\u001d').map((s) => s.trim()).filter(Boolean) })
  }
}

let prs = []
try {
  const date = git('log', '-1', '--format=%cI', since)
  const out = execFileSync('gh', ['pr', 'list', '--state', 'merged', '--search', `merged:>${date}`, '--limit', '200', '--json', 'number,title,body,url,labels'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  prs = JSON.parse(out)
} catch {
  console.error('whats-changed: no pull requests read (gh missing or signed out); commit trailers only')
}
for (const pr of prs) {
  const labels = (pr.labels ?? []).map((l) => l.name)
  if (labels.includes('urgent')) {
    const why = (pr.body ?? '').match(/^Urgent:\s*(.+)$/m)?.[1]?.trim() ?? pr.title
    urgent.push({ why, ref: `#${pr.number}` })
  }
  if (!labels.includes('user-facing')) continue
  const body = (pr.body ?? '').replace(/<!--[\s\S]*?-->/g, '')
  const section = body.split(/^## For users\s*$/m)[1]?.split(/^## /m)[0] ?? ''
  const note = section.split('\n').map((s) => s.replace(/^[-*]\s*/, '').trim()).find(Boolean) ?? pr.title
  const reports = [...body.matchAll(/^Reported-in:\s*(\S+)/gm)].map((m) => m[1])
  if (!notes.some((n) => n.note === note)) notes.push({ note, ref: `#${pr.number}`, url: pr.url, reports })
}

if (values.json) console.log(JSON.stringify({ since, urgent: urgent.length > 0, urgentReasons: urgent, notes }, null, 2))
else if (notes.length || urgent.length) {
  const head = urgent.length ? ['**Please update.** ' + urgent.map((u) => u.why.replace(/\.$/, '')).join('; ') + '.', ''] : []
  console.log([...head, '## What changed', '', ...notes.map((n) => `- ${n.note}`)].join('\n'))
}
else console.error(`whats-changed: nothing marked for people since ${since}`)
