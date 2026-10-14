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
import { hostPlatform, parseSums, platformOf, writePackageManifest, kitPackages } from './pack-integrator-kit.mjs'

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
      // relative paths from the release folder: GNU tar on Windows reads C:\ in an archive path as a remote host
      execFileSync('tar', ['-czf', name, '-C', join('..', 'src', platform), `slicerx-engine-9.9.9-${platform}`], { cwd: release })
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


test('stable package names and manifest follow upgrades with distinct package versions', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sx-kit-names-'))
  try {
    for (const version of ['0.1.0', '0.1.4']) {
      const packages = ['viewport', 'embed', 'mcp'].map((part) => ({
        name: `@slicerx/${part}`, version: part === 'mcp' ? '0.1.5' : version,
      }))
      for (const p of packages) {
        const stem = p.name.replace('@', '').replace('/', '-')
        writeFileSync(join(tmp, `${stem}-${p.version}.tgz`), `${p.name}@${p.version}`)
      }
      writePackageManifest(tmp, packages)
      const manifest = JSON.parse(readFileSync(join(tmp, 'kit-manifest.json'), 'utf8'))
      assert.equal(manifest.schemaVersion, 1)
      assert.equal(manifest.packages.length, 3)
      for (const p of manifest.packages) {
        const bytes = readFileSync(join(tmp, p.file))
        assert.equal(bytes.toString(), `${p.name}@${p.version}`)
        assert.deepEqual(bytes, readFileSync(join(tmp, p.archive)))
        assert.equal(createHash('sha256').update(bytes).digest('hex'), p.sha256)
      }
      assert.equal(manifest.packages[0].file, 'slicerx-viewport.tgz')
      assert.equal(manifest.packages[0].version, version)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})


test('kit metadata comes from the actual workspace package folders', () => {
  const packages = kitPackages()
  assert.deepEqual(packages.map((p) => p.name), ['@slicerx/viewport', '@slicerx/embed', '@slicerx/mcp'])
  for (const p of packages) assert.match(p.version, /^\d+\.\d+\.\d+/)
})

test('the manifest guide is copied and included by the embedding packages', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sx-kit-docs-'))
  try {
    execFileSync(process.execPath, [resolve(import.meta.dirname, 'copy-integrator-docs.mjs'), tmp])
    const guide = readFileSync(join(tmp, 'kit-manifest.md'), 'utf8')
    assert.match(guide, /schemaVersion: 1/)
    assert.match(readFileSync(join(tmp, 'quickstart.md'), 'utf8'), /\(kit-manifest\.md\)/)
    for (const p of kitPackages().filter((p) => p.name !== '@slicerx/viewport')) {
      assert.ok(p.files.includes('kit-manifest.md'), `${p.name} must pack the linked guide`)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
