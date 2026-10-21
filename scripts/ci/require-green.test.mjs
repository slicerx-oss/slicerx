// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'

const required = readFileSync(new URL('./required-checks.txt', import.meta.url), 'utf8').split(/\r?\n/).filter((s) => s && !s.startsWith('#'))
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
const posix = (p) => p.replaceAll('\\', '/')

// A raw `curl -i` reply: status line, headers, blank line, JSON body.
const reply = (status, runs, headers = []) => `HTTP/2 ${status}\r\n${headers.join('\r\n')}${headers.length ? '\r\n' : ''}\r\n${JSON.stringify({ check_runs: runs })}`
const run = (id, name, status = 'completed', conclusion = 'success') => ({ id, name, status, conclusion: status === 'completed' ? conclusion : null })
const allGreen = (override = {}) => required.map((name, i) => run(i + 1, name, 'completed', override[name] ?? 'success'))

// gh fails; curl and sleep are shell functions. curl answers call n with reply-n.txt from a directory and logs its
// arguments; sleep only logs. No network is used.
const FAKES = `
gh() { return 1; }
curl() { n=$(( $(cat "$FIX/calls" 2>/dev/null | wc -l) + 1 )); echo "$*" >> "$FIX/calls"; cat "$FIX/reply-$n.txt" || return 22; }
sleep() { echo "$1" >> "$FIX/sleeps"; }
export -f gh curl sleep
bash scripts/ci/require-green.sh "$@"
`

function gate(replies, args = ['HEAD', 'slicerx-oss/slicerx'], env = {}, script = FAKES) {
  const dir = mkdtempSync(join(tmpdir(), 'sx-require-green-'))
  try {
    replies.forEach((text, i) => writeFileSync(join(dir, `reply-${i + 1}.txt`), text))
    const result = spawnSync(bash, ['-c', script, 'bash', ...args], {
      encoding: 'utf8',
      env: { ...process.env, FIX: posix(dir), SX_GREEN_GH: '', SX_GREEN_WAIT: '0', SX_GREEN_POLL: '', SX_PUBLISH_ALLOW_RED: '0', ...env },
    })
    const read = (name) => { try { return readFileSync(join(dir, name), 'utf8').split('\n').filter(Boolean) } catch { return [] } }
    return { result, calls: read('calls'), sleeps: read('sleeps') }
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()))
    rmSync(dir, { recursive: true, force: true })
  }
}

test('reads check runs anonymously when gh fails, and says so once', () => {
  const { result, calls } = gate([reply(200, allGreen())])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /has every required check green/)
  assert.equal(result.stderr.match(/gh unavailable, reading check runs anonymously/g)?.length, 1)
  assert.equal(calls.length, 1)
  assert.match(calls[0], /https:\/\/api\.github\.com\/repos\/slicerx-oss\/slicerx\/commits\/[0-9a-f]{40}\/check-runs\?per_page=100/)
  assert.match(calls[0], /User-Agent: slicerx-require-green/)
  assert.match(calls[0], /Accept: application\/vnd\.github\+json/)
  assert.doesNotMatch(calls[0], /authorization|token|bearer/i)
})

test('SX_GREEN_GH=0 skips a working gh', () => {
  const script = FAKES.replace('gh() { return 1; }', 'gh() { echo "gh must not be called" >&2; return 0; }')
  const { result } = gate([reply(200, allGreen())], undefined, { SX_GREEN_GH: '0' }, script)
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stderr, /gh must not be called/)
})

test('follows the Link rel="next" page and keeps the latest run per name', () => {
  const next = 'https://api.github.com/repositories/1/commits/abc/check-runs?per_page=100&page=2'
  const all = allGreen()
  const half = Math.ceil(all.length / 2)
  const last = required[required.length - 1]
  // Page one ends with an old failed run of the last check; page two decides whether a newer run replaced it.
  const older = run(900, last, 'completed', 'failure')
  const link = [`link: <${next}>; rel="next", <https://api.github.com/x?page=2>; rel="last"`]
  const red = gate([reply(200, [...all.slice(0, half), older], link), reply(200, all.slice(half).filter((r) => r.name !== last))])
  assert.equal(red.result.status, 1, red.result.stderr)
  assert.equal(red.calls.length, 2)
  assert.ok(red.calls[1].includes(next))
  assert.match(red.result.stderr, new RegExp(`${last.replace(/[()]/g, '\\$&')}: failure`))

  const newer = run(1000, last, 'completed', 'success')
  const ok = gate([reply(200, [...all.slice(0, half), older], link), reply(200, [...all.slice(half).filter((r) => r.name !== last), newer])])
  assert.equal(ok.result.status, 0, ok.result.stderr)
  assert.equal(ok.calls.length, 2)
})

test('a red or missing check is refused, a skipped one passes', () => {
  const red = gate([reply(200, allGreen({ web: 'failure' }))])
  assert.equal(red.result.status, 1)
  assert.match(red.result.stderr, /web: failure/)
  const missing = gate([reply(200, allGreen().filter((r) => r.name !== 'wasm'))])
  assert.equal(missing.result.status, 1)
  assert.match(missing.result.stderr, /wasm: missing/)
  const skipped = gate([reply(200, allGreen({ pgtap: 'skipped' }))])
  assert.equal(skipped.result.status, 0, skipped.result.stderr)
})

test('waits for a pending check and goes green on the next read', () => {
  const pending = allGreen().map((r) => (r.name === 'e2e' ? run(r.id, r.name, 'in_progress') : r))
  const { result, calls, sleeps } = gate([reply(200, pending), reply(200, allGreen())], undefined, { SX_GREEN_WAIT: '5', SX_GREEN_POLL: '1' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(calls.length, 2)
  assert.deepEqual(sleeps, ['1'])
  assert.equal(result.stderr.match(/reading check runs anonymously/g)?.length, 1)

  const still = gate([reply(200, pending), reply(200, pending)], undefined, { SX_GREEN_WAIT: '0', SX_GREEN_POLL: '0' })
  assert.equal(still.result.status, 1)
  assert.match(still.result.stderr, /e2e: in_progress/)
})

test('polls every 300 s when anonymous and the reply has no rate limit headers, unless SX_GREEN_POLL is set', () => {
  const pending = allGreen().map((r) => (r.name === 'e2e' ? run(r.id, r.name, 'queued') : r))
  const dflt = gate([reply(200, pending), reply(200, allGreen())], undefined, { SX_GREEN_WAIT: '400' })
  assert.equal(dflt.result.status, 0, dflt.result.stderr)
  assert.deepEqual(dflt.sleeps, ['300'])
  const explicit = gate([reply(200, pending), reply(200, allGreen())], undefined, { SX_GREEN_WAIT: '400', SX_GREEN_POLL: '7' })
  assert.deepEqual(explicit.sleeps, ['7'])
})

test('paces anonymous polls by the reads left until the rate limit resets', () => {
  const pending = allGreen().map((r) => (r.name === 'e2e' ? run(r.id, r.name, 'queued') : r))
  const limit = (left, inSecs) => [`x-ratelimit-remaining: ${left}`, `x-ratelimit-reset: ${Math.floor(Date.now() / 1000) + inSecs}`]
  const slept = (left, inSecs, env = {}) => {
    const { result, sleeps } = gate([reply(200, pending, limit(left, inSecs)), reply(200, allGreen())], undefined, { SX_GREEN_WAIT: '4000', ...env })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(sleeps.length, 1)
    return Number(sleeps[0])
  }
  // 49 spare reads over 3500 s: about 72 s, not 300
  const fresh = slept(59, 3500)
  assert.ok(fresh >= 70 && fresh <= 73, String(fresh))
  // never faster than 20 s, never slower than 300 s while reads are spare
  assert.equal(slept(59, 60), 20)
  assert.equal(slept(12, 3000), 300)
  // none spare: wait for the reset
  const out = slept(10, 100)
  assert.ok(out >= 99 && out <= 101, String(out))
  assert.equal(slept(59, 3500, { SX_GREEN_POLL: '7' }), 7)
})

test('a 403 or 429 reply is an API error, exit 2, with a rate limit message', () => {
  for (const status of [403, 429]) {
    const { result } = gate([`HTTP/2 ${status}\r\nx-ratelimit-remaining: 0\r\n\r\n{"message":"API rate limit exceeded"}`])
    assert.equal(result.status, 2, `${status}: ${result.stderr}`)
    assert.match(result.stderr, new RegExp(`HTTP ${status}.*60 per hour`))
    assert.match(result.stderr, /could not read check runs/)
  }
  const other = gate([`HTTP/2 404\r\n\r\n{"message":"Not Found"}`])
  assert.equal(other.result.status, 2)
  assert.match(other.result.stderr, /HTTP 404/)
  const dead = gate([])
  assert.equal(dead.result.status, 2, 'curl failing outright is an API error too')
})

test('without a slug argument, the repository comes from the origin URL when gh cannot tell it', () => {
  const { result, calls } = gate([reply(200, allGreen())], ['HEAD'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(calls[0], /https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/commits\//)
})
