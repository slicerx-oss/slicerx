// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The "What changed" list for a release's notes: one plain line per change people will notice.
//   node apps/desktop/release/whats-changed.mjs [--since <tag>] [--to <commit>] [--json]
// Sources, both optional:
// - a commit trailer `User-note: <one line>` on a commit pushed straight to main
// - a merged pull request with the `user-facing` label: the first line under its "## For users" heading,
//   else its title (read with the gh CLI; skipped when gh is missing or signed out). Only pull requests whose merge
//   commit is in since..to count, so a run that stops at an older commit leaves out what merged after it.
// One line per change: a pull request whose own commits carry a User-note is listed by those notes, and its "For users"
// text is left out. A "For users" line that points at a table or at main as a branch (NO_CONTEXT) is skipped with a
// warning, since it makes no sense on its own. Each line starts with a capital letter.
// `Reported-in: <link>` (a trailer, or a line in the pull request body) names the bug report the change fixes,
// so the release bot can reply there. `Urgent: <why people must update>` (a trailer, or a pull request with the
// `urgent` label and the same line in its body) marks a hotfix: the release notes ask everyone to update and the
// bot pings for it. Everything else is announced without a ping. `User-note-replaces: <commit>` drops the User-note of an
// earlier commit that said something wrong, so a shared branch corrects a note without rewriting history; the new
// commit's own User-note takes its place. --since defaults to the newest desktop-v* tag, --to to HEAD.
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const gitCli = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const ghCli = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

const SEP = '\u001e'

// A pull request is in the range when its merge commit is one of the range's commits (a rebase merge names the last
// commit it replayed). One without a merge commit falls back to its merge date, which must not be after `to`.
export function inRange(prs, hashes, toDate) {
  const inLog = new Set(hashes)
  return prs.filter((pr) => {
    const oid = pr.mergeCommit?.oid
    if (oid) return inLog.has(oid)
    return !!pr.mergedAt && Date.parse(pr.mergedAt) <= Date.parse(toDate)
  })
}

// "For users" lines that lean on the pull request around them: a table (its rows, or text above or below it), or
// main as a branch ("on main", "compared with main").
export const NO_CONTEXT = [
  /\btable\b/i, /\brows?\b/i, /\bthe following\b/i,
  /\b(?:see|shown|listed|as) (?:above|below)\b/i, /\b(?:above|below) (?:is|are|shows?)\b/i, /\b(?:above|below)\s*[:.]?\s*$/i,
  /\bon main\b/i, /\bagainst main\b/i, /\bmain against\b/i, /\bwith main\b/i, /\bthan main\b/i, /\bmain had\b/i,
]
export const standsAlone = (line) => !NO_CONTEXT.some((re) => re.test(line))
export const capitalize = (line) => line.charAt(0).toUpperCase() + line.slice(1)

// Which pull request each commit came in with. main takes changes only through the merge queue, which rebases, so
// the log is each pull request's commits in a row with its merge commit (the last one replayed) newest. Reading the
// log newest first, a commit belongs to the last merge commit seen; commits newer than every merge commit to none.
export function commitPrs(hashes, prs) {
  const byMerge = new Map(prs.filter((pr) => pr.mergeCommit?.oid).map((pr) => [pr.mergeCommit.oid, pr.number]))
  const owner = new Map()
  let current
  for (const h of hashes) {
    current = byMerge.get(h) ?? current
    if (current !== undefined) owner.set(h, current)
  }
  return owner
}

export function whatsChanged({ since: sinceArg, to = 'HEAD', git = gitCli, gh = ghCli } = {}) {
  const since = sinceArg ?? git('tag', '--list', 'desktop-v*', '--sort=-creatordate').split('\n')[0]
  if (!since) throw new Error('No desktop-v* tag yet; give --since <tag or commit>.')

  const notes = []
  const urgent = []
  const noted = new Map() // short ref of a commit with a User-note -> its full hash
  const log = git('log', `${since}..${to}`, `--format=%H%x1f%h%x1f%(trailers:key=User-note,valueonly,separator=%x1d)%x1f%(trailers:key=Reported-in,valueonly,separator=%x1d)%x1f%(trailers:key=Urgent,valueonly,separator=%x1d)%x1f%(trailers:key=User-note-replaces,valueonly,separator=%x1d)${SEP}`)
  const records = log.split(SEP).map((rec) => rec.trim().split('\u001f'))
  const replaced = records.flatMap(([, , , , , gone]) => (gone ?? '').split('\u001d').map((s) => s.trim().toLowerCase()).filter((s) => /^[0-9a-f]{7,40}$/.test(s)))
  for (const [full, ref, note, reports, why] of records) {
    for (const line of (why ?? '').split('\u001d').map((s) => s.trim()).filter(Boolean)) urgent.push({ why: line, ref })
    if (!ref || !note?.trim() || replaced.some((h) => full?.startsWith(h))) continue
    for (const line of note.split('\u001d').map((s) => s.trim()).filter(Boolean)) {
      notes.push({ note: capitalize(line), ref, reports: (reports ?? '').split('\u001d').map((s) => s.trim()).filter(Boolean) })
      noted.set(ref, full)
    }
  }

  const hashes = records.map(([full]) => full).filter(Boolean)
  const date = git('log', '-1', '--format=%cI', since)
  const toDate = git('log', '-1', '--format=%cI', to)
  let prs = []
  try {
    const out = gh('pr', 'list', '--state', 'merged', '--search', `merged:>${date}`, '--limit', '200', '--json', 'number,title,body,url,labels,mergeCommit,mergedAt')
    prs = inRange(JSON.parse(out), hashes, toDate)
  } catch {
    console.error('whats-changed: no pull requests read (gh missing or signed out); commit trailers only')
  }
  const owner = commitPrs(hashes, prs)
  for (const pr of prs) {
    const labels = (pr.labels ?? []).map((l) => l.name)
    if (labels.includes('urgent')) {
      const why = (pr.body ?? '').match(/^Urgent:\s*(.+)$/m)?.[1]?.trim() ?? pr.title
      urgent.push({ why, ref: `#${pr.number}` })
    }
    if (!labels.includes('user-facing')) continue
    const body = (pr.body ?? '').replace(/<!--[\s\S]*?-->/g, '')
    const reports = [...body.matchAll(/^Reported-in:\s*(\S+)/gm)].map((m) => m[1])
    // The User-notes of its own commits already say what changed; the first keeps the pull request's bug reports.
    const own = notes.find((n) => noted.has(n.ref) && owner.get(noted.get(n.ref)) === pr.number)
    if (own) {
      own.reports = [...new Set([...own.reports, ...reports])]
      continue
    }
    const section = body.split(/^## For users\s*$/m)[1]?.split(/^## /m)[0] ?? ''
    const line = section.split('\n').map((s) => s.replace(/^[-*]\s*/, '').trim()).find(Boolean) ?? pr.title
    if (!standsAlone(line)) {
      console.error(`whats-changed: #${pr.number} left out, its "For users" text needs the pull request around it`)
      continue
    }
    const note = capitalize(line)
    if (!notes.some((n) => n.note === note)) notes.push({ note, ref: `#${pr.number}`, url: pr.url, reports })
  }
  return { since, urgent, notes }
}

// The Markdown the release notes take, or '' when nothing is marked for people.
export function render({ urgent, notes }) {
  if (!notes.length && !urgent.length) return ''
  const head = urgent.length ? ['**Please update.** ' + urgent.map((u) => u.why.replace(/\.$/, '')).join('; ') + '.', ''] : []
  return [...head, '## What changed', '', ...notes.map((n) => `- ${n.note}`)].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({ options: { since: { type: 'string' }, to: { type: 'string', default: 'HEAD' }, json: { type: 'boolean', default: false } } })
  const { since, urgent, notes } = whatsChanged({ since: values.since, to: values.to })
  if (values.json) console.log(JSON.stringify({ since, urgent: urgent.length > 0, urgentReasons: urgent, notes }, null, 2))
  else if (notes.length || urgent.length) console.log(render({ urgent, notes }))
  else console.error(`whats-changed: nothing marked for people since ${since}`)
}
