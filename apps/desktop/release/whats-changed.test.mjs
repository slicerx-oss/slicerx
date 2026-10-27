// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The "What changed" list has one line per change: a pull request whose commits carry a User-note is listed by those
// notes, "For users" lines that need the pull request around them are skipped, and every line starts with a capital.
// fixtures/whats-changed-0.2.15.json is the desktop-v0.2.14..desktop-v0.2.15 range as git and gh gave it.
// Usage: node --test apps/desktop/release/whats-changed.test.mjs (pnpm test:scripts)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { capitalize, commitPrs, NO_CONTEXT, render, standsAlone, whatsChanged } from './whats-changed.mjs'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/whats-changed-0.2.15.json', import.meta.url), 'utf8'))

const join = (list) => (list ?? []).join('\u001d')
const record = (c) => [c.hash, c.hash.slice(0, 8), join(c.userNote), join(c.reportedIn), join(c.urgent), join(c.replaces)].join('\u001f') + '\u001e'

// git and gh stubbed from a list of commits (newest first) and pull requests, the way the script calls them.
function stubs({ commits, prs, sinceDate = '2026-10-20T00:00:00Z', toDate = '2026-10-22T00:00:00Z' }) {
  const git = (...args) => {
    if (args[0] === 'log' && args[1] === '-1') return args[3] === 'HEAD' || args[3] === fixture.to ? toDate : sinceDate
    if (args[0] === 'log') return commits.map(record).join('\n')
    throw new Error(`unexpected git ${args.join(' ')}`)
  }
  return { git, gh: () => JSON.stringify(prs) }
}

const run = (data, to = 'HEAD') => whatsChanged({ since: 'desktop-v0.2.9', to, ...stubs(data) })
const lines = (r) => render(r).split('\n').filter((l) => l.startsWith('- '))

const hash = (n) => String(n).repeat(40).slice(0, 40)
const pr = (number, merged, forUsers, labels = ['user-facing']) => ({
  number,
  title: `fix: change ${number}`,
  body: forUsers === null ? 'No section.\n' : `## What this changes\n\nSomething.\n\n## For users\n\n${forUsers}\n\n## How it was tested\n\nRan it.\n`,
  url: `https://example.test/pull/${number}`,
  labels: labels.map((name) => ({ name })),
  mergeCommit: { oid: hash(merged) },
  mergedAt: '2026-10-21T00:00:00Z',
})

test('0.2.15: one line per change, none that needs a table or main, each capitalized', () => {
  const r = run({ commits: fixture.commits, prs: fixture.prs, sinceDate: fixture.sinceDate, toDate: fixture.toDate }, fixture.to)
  const out = lines(r)
  assert.equal(new Set(out).size, out.length, 'no line twice')
  for (const l of out) assert.match(l, /^- [A-Z]/, `starts lowercase: ${l}`)
  for (const n of r.notes.filter((n) => n.ref.startsWith('#'))) assert.ok(standsAlone(n.note), `needs context: ${n.note}`)
  // every User-note is listed once, and only pull requests without one add their own line
  const userNotes = fixture.commits.flatMap((c) => c.userNote ?? [])
  assert.deepEqual(out.slice(0, userNotes.length), userNotes.map((n) => `- ${capitalize(n)}`))
  assert.deepEqual(r.notes.slice(userNotes.length).map((n) => n.ref), ['#1525', '#1522'])
  assert.equal(out.length, userNotes.length + 2)
  assert.ok(!out.some((l) => l.startsWith('- Layer counts on a 20 mm cube')))
  assert.ok(!out.some((l) => l.includes('On main, an A1 plate')))
  assert.ok(out.includes('- The preview draws a P1S, X1 or Neptune 4 purge line where it prints'))
})

test('a pull request whose commits carry a User-note is listed by the note alone', () => {
  // log newest first: 3 is #20's merge commit (the note's own commit), 2 its other commit, 1 is #19's merge commit
  const commits = [{ hash: hash(3), userNote: ['Note from the commit.'] }, { hash: hash(2) }, { hash: hash(1) }]
  const prs = [pr(20, 3, 'Longer text for the same change.'), pr(19, 1, 'Text from a pull request with no note.')]
  assert.deepEqual(run({ commits, prs }).notes.map((n) => [n.note, n.ref]), [['Note from the commit.', hash(3).slice(0, 8)], ['Text from a pull request with no note.', '#19']])
})

test('a User-note on an earlier commit of the pull request also replaces its text', () => {
  const commits = [{ hash: hash(3) }, { hash: hash(2), userNote: ['Note on the first commit.'] }]
  assert.deepEqual(run({ commits, prs: [pr(20, 3, 'Text again.')] }).notes.map((n) => n.note), ['Note on the first commit.'])
})

test("the pull request's bug reports move to its first User-note", () => {
  const commits = [{ hash: hash(3), userNote: ['First.', 'Second.'], reportedIn: ['https://example.test/a'] }]
  const prs = [{ ...pr(20, 3, 'Text.'), body: '## For users\n\nText.\nReported-in: https://example.test/b\n' }]
  const r = run({ commits, prs })
  assert.deepEqual(r.notes.map((n) => [n.note, n.reports]), [['First.', ['https://example.test/a', 'https://example.test/b']], ['Second.', ['https://example.test/a']]])
})

test('commits map to the pull request whose merge commit follows them in the log', () => {
  const owner = commitPrs([hash(5), hash(4), hash(3), hash(2), hash(1)], [pr(20, 4, ''), pr(19, 2, '')])
  assert.deepEqual([...owner], [[hash(4), 20], [hash(3), 20], [hash(2), 19], [hash(1), 19]])
})

// One line per NO_CONTEXT pattern, and lines that only look like them.
const skippedLines = [
  'Layer counts on a 20 mm cube, one per row.',
  'See the table for the times.',
  'The following plates slice faster:',
  'As above, slicing is faster.',
  'The numbers below are medians.',
  'Slicing is faster, see below.',
  'Times are listed below:',
  'On main, the plate printed late.',
  'Timed against main on the P1S.',
  'Main against this branch, P1S.',
  'Compared with main, one case is slower.',
  'Faster than main by 2%.',
  'Before, main had the wrong width.',
]
const keptLines = ['Layer heights above or below the listed range print as set.', 'Mainly, walls print at size.', 'The domain list loads.', 'Arrange fills the plate.']

test('a "For users" line that points at a table or at main is left out', () => {
  for (const line of skippedLines) assert.equal(standsAlone(line), false, line)
  for (const line of keptLines) assert.ok(standsAlone(line), line)
  for (const re of NO_CONTEXT) assert.ok(skippedLines.some((l) => re.test(l)), `no test line for ${re}`)

  const err = []
  const orig = console.error
  console.error = (m) => err.push(m)
  try {
    const commits = [{ hash: hash(2) }, { hash: hash(1) }]
    const prs = [pr(20, 2, 'On main, the plate printed late.'), pr(19, 1, 'Mainly, walls print at size.')]
    assert.deepEqual(run({ commits, prs }).notes.map((n) => n.note), ['Mainly, walls print at size.'])
  } finally {
    console.error = orig
  }
  assert.equal(err.length, 1)
  assert.match(err[0], /#20 left out/)
})

test('every line starts with a capital letter', () => {
  const commits = [{ hash: hash(3), userNote: ['the preview draws the purge line.'] }, { hash: hash(1) }]
  const r = run({ commits, prs: [pr(19, 1, '- walls print at size.')] })
  assert.deepEqual(lines(r), ['- The preview draws the purge line.', '- Walls print at size.'])
  assert.equal(capitalize(''), '')
  assert.equal(capitalize('`sx slice` is faster.'), '`sx slice` is faster.')
})

test('a change with only one source comes out as before', () => {
  // commit 4 is pushed after every merge commit, so it has no pull request; #19 and #18 have no User-note
  const commits = [{ hash: hash(4), userNote: ['Trailer note.'] }, { hash: hash(2) }, { hash: hash(1) }]
  const prs = [pr(19, 2, 'Pull request note.'), pr(18, 1, null), pr(17, 1, 'Not for users.', ['roadmap:other'])]
  const r = run({ commits, prs })
  assert.deepEqual(r.notes, [
    { note: 'Trailer note.', ref: hash(4).slice(0, 8), reports: [] },
    { note: 'Pull request note.', ref: '#19', url: 'https://example.test/pull/19', reports: [] },
    { note: 'Fix: change 18', ref: '#18', url: 'https://example.test/pull/18', reports: [] },
  ])
  assert.equal(render(r), '## What changed\n\n- Trailer note.\n- Pull request note.\n- Fix: change 18')
})
