// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Usage: node --test scripts/pack-integrator-kit.test.mjs (pnpm test:scripts)
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { hostPlatform, parseSums, platformOf } from './pack-integrator-kit.mjs'

const script = resolve(import.meta.dirname, 'pack-integrator-kit.mjs')

test('reads SHA256SUMS.txt and names the platform of each archive', () => {
  const a = 'a'.repeat(64)
  const sums = parseSums(`${a}  slicerx-engine-0.1.3-linux-x64.tar.gz\r\n${'B'.repeat(64)} *slicerx-engine-0.1.3-windows-x64.zip\n\nnot a line\n`)
  assert.deepEqual([...sums], [
    ['slicerx-engine-0.1.3-linux-x64.tar.gz', a],
    ['slicerx-engine-0.1.3-windows-x64.zip', 'b'.repeat(64)],
  ])
  assert.equal(platformOf('slicerx-engine-0.1.3-macos-universal.tar.gz'), 'macos-universal')
  assert.equal(platformOf('slicerx-engine-0.1.3-windows-x64.zip'), 'windows-x64')
  assert.equal(platformOf('SHA256SUMS.txt'), undefined)
  assert.equal(hostPlatform('darwin', 'arm64'), 'macos-universal')
  assert.equal(hostPlatform('darwin', 'x64'), 'macos-universal')
  assert.equal(hostPlatform('win32', 'x64'), 'windows-x64')
  assert.equal(hostPlatform('linux', 'x64'), 'linux-x64')
  assert.equal(hostPlatform('linux', 'arm64'), undefined)
})

test('lays out a folder of engine archives per platform and refuses one that does not match its checksum', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sx-kit-test-'))
  try {
    const release = join(tmp, 'release')
    mkdirSync(release)
    const lines = []
    for (const platform of ['linux-x64', 'macos-universal']) {
      const top = join(tmp, 'src', platform, `slicerx-engine-9.9.9-${platform}`)
      mkdirSync(join(top, 'bin'), { recursive: true })
      writeFileSync(join(top, 'bin', 'sx'), `sx for ${platform}\n`)
      const name = `slicerx-engine-9.9.9-${platform}.tar.gz`
      execFileSync('tar', ['-czf', join(release, name), '-C', join(tmp, 'src', platform), `slicerx-engine-9.9.9-${platform}`])
      lines.push(`${createHash('sha256').update(readFileSync(join(release, name))).digest('hex')}  ${name}`)
    }
    writeFileSync(join(release, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`)

    const kit = join(tmp, 'kit')
    const ok = spawnSync(process.execPath, [script, kit, '--engine', release, '--engine-only'], { encoding: 'utf8' })
    assert.equal(ok.status, 0, ok.stderr)
    assert.equal(readFileSync(join(kit, 'engine', 'linux-x64', 'bin', 'sx'), 'utf8'), 'sx for linux-x64\n')
    assert.equal(readFileSync(join(kit, 'engine', 'macos-universal', 'bin', 'sx'), 'utf8'), 'sx for macos-universal\n')
    assert.ok(!existsSync(join(kit, 'engine', 'windows-x64')))
    assert.ok(!existsSync(join(kit, '.engine-unpack')))
    const source = readFileSync(join(kit, 'engine', 'SOURCE.txt'), 'utf8')
    assert.match(source, /^Engine archives from /)
    for (const l of lines) assert.ok(source.includes(l), l)

    const bad = join(release, 'slicerx-engine-9.9.9-linux-x64.tar.gz')
    const bytes = readFileSync(bad)
    bytes[bytes.length - 1] ^= 1
    writeFileSync(bad, bytes)
    const refused = spawnSync(process.execPath, [script, join(tmp, 'kit2'), '--engine', release, '--engine-only'], { encoding: 'utf8' })
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /slicerx-engine-9\.9\.9-linux-x64\.tar\.gz: SHA-256 [0-9a-f]{64} does not match SHA256SUMS\.txt/)
    assert.ok(!existsSync(join(tmp, 'kit2', 'engine')))

    const noTag = spawnSync(process.execPath, [script, join(tmp, 'kit3'), '--engine-only'], { encoding: 'utf8' })
    assert.equal(noTag.status, 1)
    assert.match(noTag.stderr, /--engine-only needs --engine/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
