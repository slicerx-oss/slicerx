// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// net-retry.sh against commands that fail a set number of times: the pauses and tries it makes by default (with a
// stand-in for sleep that records them), the command's own exit code after the last try, a pass on a later try, and the
// annotation each failed try leaves.
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'net-retry.sh')

// A command that fails with `code` until it has run `passOn` times (0: never passes); its runs are counted in a file.
function fixture(code, passOn) {
  const dir = mkdtempSync(join(tmpdir(), 'net-retry-'))
  const count = join(dir, 'count')
  const cmd = join(dir, 'cmd.sh')
  writeFileSync(
    cmd,
    `n=$(cat "${count}" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "${count}"\n` +
      (passOn > 0 ? `[ "$n" -ge ${passOn} ] && exit 0\n` : '') +
      `exit ${code}\n`,
  )
  const sleep = join(dir, 'sleep')
  writeFileSync(sleep, `#!/bin/sh\necho "$1" >> "${join(dir, 'pauses')}"\n`)
  chmodSync(sleep, 0o755)
  const run = (env = {}) => {
    const r = spawnSync('sh', [script, 'sh', cmd], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env },
    })
    const read = (f) => {
      try {
        return readFileSync(join(dir, f), 'utf8')
      } catch {
        return ''
      }
    }
    return {
      status: r.status,
      stderr: r.stderr,
      tries: Number(read('count').trim() || 0),
      pauses: read('pauses').trim().split('\n').filter(Boolean),
    }
  }
  return run
}

describe('net-retry.sh', () => {
  it('runs a command that passes once, without a pause', () => {
    const r = fixture(7, 1)()
    assert.equal(r.status, 0)
    assert.equal(r.tries, 1)
    assert.deepEqual(r.pauses, [])
    assert.ok(!r.stderr.includes('::warning'))
  })

  it('passes on a later try and annotates each failed one', () => {
    const r = fixture(7, 3)({ SX_NET_RETRY_DELAYS: '0 0 0' })
    assert.equal(r.status, 0)
    assert.equal(r.tries, 3)
    assert.equal(r.stderr.match(/::warning title=Network retry::try \d of 4 failed with exit code 7/g).length, 2)
  })

  it('makes 4 tries with pauses of 10, 30 and 60 seconds, then exits with the command exit code', () => {
    const r = fixture(42, 0)()
    assert.equal(r.status, 42)
    assert.equal(r.tries, 4)
    assert.deepEqual(r.pauses, ['10', '30', '60'])
    assert.equal(r.stderr.match(/::warning/g).length, 4)
  })

  it('takes the pauses from SX_NET_RETRY_DELAYS', () => {
    const r = fixture(3, 0)({ SX_NET_RETRY_DELAYS: '1 2' })
    assert.equal(r.status, 3)
    assert.equal(r.tries, 3)
    assert.deepEqual(r.pauses, ['1', '2'])
  })

  it('needs a command', () => {
    const r = spawnSync('sh', [script], { encoding: 'utf8' })
    assert.equal(r.status, 2)
  })
})
