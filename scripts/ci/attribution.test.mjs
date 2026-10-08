// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// attribution.mjs: the patterns, the range each GitHub event checks, and a run on a small repository.
// Usage: node --test scripts/ci/attribution.test.mjs (pnpm test:scripts)
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { hits, range } from './attribution.mjs'

const script = join(dirname(fileURLToPath(import.meta.url)), 'attribution.mjs')

test('catches trailers, generated-with lines and session links, in any case', () => {
  for (const line of [
    'Co-Authored-By: Claude Opus <noreply@anthropic.com>',
    'co-authored-by:claude',
    'Claude-Session: https://example.com/x',
    'Generated with [Claude Code](https://example.com)',
    'generated with claude',
    'see https://claude.ai/code/session_01AbC',
    'https://CLAUDE.AI/share/0a1b2c',
    'https://claude.ai/chat/0a1b2c',
    'Signed-off-by: Bot <noreply@anthropic.com>',
  ]) {
    assert.deepEqual(hits(`fix: a thing\n\n${line}\n`), [line], line)
  }
})

test('leaves ordinary text alone', () => {
  const text = [
    'feat(plugin): the Claude plugin lists printers',
    'Co-authored-by: Pat Doe <pat@example.com>',
    'Signed-off-by: Sean Leonard <sean@suby.dev>',
    'Docs at https://claude.ai and https://docs.anthropic.com',
  ].join('\n')
  assert.deepEqual(hits(text), [])
})

test('reads lines with CRLF endings', () => {
  assert.deepEqual(hits('summary\r\nClaude-Session: x\r\nmore\r\n'), ['Claude-Session: x'])
})

test('checks the pull request commits, the queued commits, or what a push added', () => {
  assert.deepEqual(range({ GITHUB_EVENT_NAME: 'pull_request', BASE_SHA: 'b', HEAD_SHA: 'h', GITHUB_SHA: 'm' }), ['b..h'])
  assert.deepEqual(range({ GITHUB_EVENT_NAME: 'merge_group', MQ_BASE_SHA: 'b', MQ_HEAD_SHA: 'h', GITHUB_SHA: 'h' }), ['b..h'])
  assert.deepEqual(range({ GITHUB_EVENT_NAME: 'push', PUSH_BEFORE: 'a', GITHUB_SHA: 'c' }), ['a..c'])
  assert.deepEqual(range({ GITHUB_EVENT_NAME: 'push', PUSH_BEFORE: '0000000000', GITHUB_SHA: 'c' }), ['-1', 'c'])
  assert.deepEqual(range({ GITHUB_EVENT_NAME: 'push', GITHUB_SHA: 'c' }), ['-1', 'c'])
  assert.equal(range({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: 'm' }), null)
  assert.equal(range({}), null)
})

function repo(messages) {
  const dir = mkdtempSync(join(tmpdir(), 'attribution-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q')
  const shas = messages.map((m) => {
    git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', m)
    return git('rev-parse', 'HEAD')
  })
  return { dir, shas }
}

function run(dir, args, env = {}) {
  const clean = { ...process.env }
  for (const k of ['GITHUB_EVENT_NAME', 'GITHUB_SHA', 'BASE_SHA', 'HEAD_SHA', 'MQ_BASE_SHA', 'MQ_HEAD_SHA', 'PUSH_BEFORE', 'PR_BODY']) delete clean[k]
  const r = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8', env: { ...clean, ...env } })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

test('looks only at the commits in the range', () => {
  const { dir, shas } = repo(['chore: old\n\nClaude-Session: x', 'feat: base', 'fix: one', 'fix: two'])
  try {
    const clean = run(dir, [], { GITHUB_EVENT_NAME: 'pull_request', BASE_SHA: shas[1], HEAD_SHA: shas[3] })
    assert.equal(clean.code, 0, clean.err)
    assert.match(clean.out, /none in 2 commit\(s\)/)
    const all = run(dir, [shas[3]])
    assert.equal(all.code, 1)
    assert.match(all.out, /^commit [0-9a-f]+: Claude-Session: x$/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fails on a trailer in a pull request commit, and on a session link in the body alone', () => {
  const { dir, shas } = repo(['feat: base', 'fix: one\n\nCo-Authored-By: Claude <noreply@anthropic.com>', 'fix: two'])
  try {
    const pr = { GITHUB_EVENT_NAME: 'pull_request', BASE_SHA: shas[0], HEAD_SHA: shas[2] }
    const r = run(dir, [], pr)
    assert.equal(r.code, 1)
    assert.match(r.out, /Co-Authored-By: Claude/)
    assert.match(r.err, /1 line\(s\) of AI attribution in 2 commit\(s\)/)
    const body = run(dir, [], { ...pr, BASE_SHA: shas[1], PR_BODY: 'What changed.\r\n\r\nhttps://claude.ai/code/session_01AbC\r\n' })
    assert.equal(body.code, 1)
    assert.match(body.out, /^pull request body: https:\/\/claude\.ai\/code\/session_01AbC$/m)
    assert.equal(run(dir, [], { ...pr, BASE_SHA: shas[1], PR_BODY: 'What changed.' }).code, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a push checks what it added, or its head alone for a new branch', () => {
  const { dir, shas } = repo(['fix: one\n\nClaude-Session: x', 'fix: two'])
  try {
    assert.equal(run(dir, [], { GITHUB_EVENT_NAME: 'push', PUSH_BEFORE: shas[0], GITHUB_SHA: shas[1] }).code, 0)
    assert.equal(run(dir, [], { GITHUB_EVENT_NAME: 'push', PUSH_BEFORE: '0'.repeat(40), GITHUB_SHA: shas[1] }).code, 0)
    assert.equal(run(dir, [], { GITHUB_EVENT_NAME: 'push', PUSH_BEFORE: '0'.repeat(40), GITHUB_SHA: shas[0] }).code, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('exits 2 with no range, or a range git cannot read', () => {
  const { dir } = repo(['feat: base'])
  try {
    assert.equal(run(dir, [], { GITHUB_EVENT_NAME: 'pull_request' }).code, 2)
    const r = run(dir, ['deadbeef..cafebabe'])
    assert.equal(r.code, 2)
    assert.match(r.err, /cannot read the commits/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
