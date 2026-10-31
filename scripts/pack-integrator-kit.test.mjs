// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Usage: node --test scripts/pack-integrator-kit.test.mjs (pnpm test:scripts)
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { addToSums, hostPlatform, parseSums, platformOf, writePackageManifest, kitPackages } from './pack-integrator-kit.mjs'

const stemOf = (name) => name.replace('@', '').replace('/', '-')

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
  assert.deepEqual(packages.map((p) => p.name), ['@slicerx/viewport', '@slicerx/embed', '@slicerx/mcp', '@slicerx/step-reader'])
  for (const p of packages) assert.match(p.version, /^\d+\.\d+\.\d+/)
})

test('the STEP reader is its own optional tarball on the kit version line, listed in the manifest and SHA256SUMS.txt', () => {
  const packages = kitPackages()
  const mcp = packages.find((p) => p.name === '@slicerx/mcp')
  const step = packages.find((p) => p.name === '@slicerx/step-reader')
  assert.ok(step, 'the kit packs @slicerx/step-reader')
  // one version line for the kit's packages, so a kit names one version
  for (const p of packages) assert.equal(p.version, mcp.version, p.name)
  // the server loads the reader only when it is installed beside it: an optional peer, never a dependency
  assert.equal(mcp.dependencies?.['@slicerx/step-reader'], undefined)
  assert.equal(mcp.peerDependenciesMeta?.['@slicerx/step-reader']?.optional, true)
  assert.equal(mcp.peerDependencies?.['@slicerx/step-reader'], `^${step.version}`)

  const tmp = mkdtempSync(join(tmpdir(), 'sx-kit-step-'))
  try {
    const entries = packages.map(({ name, version }) => ({ name, version }))
    for (const p of entries) writeFileSync(join(tmp, `${stemOf(p.name)}-${p.version}.tgz`), `${p.name}@${p.version}`)
    writePackageManifest(tmp, entries)
    const manifest = JSON.parse(readFileSync(join(tmp, 'kit-manifest.json'), 'utf8'))
    const entry = manifest.packages.find((p) => p.name === '@slicerx/step-reader')
    assert.deepEqual(entry, {
      name: '@slicerx/step-reader', version: step.version, file: 'slicerx-step-reader.tgz', archive: `slicerx-step-reader-${step.version}.tgz`,
      sha256: createHash('sha256').update(`@slicerx/step-reader@${step.version}`).digest('hex'), optional: true,
    })
    for (const p of manifest.packages.filter((p) => p.name !== '@slicerx/step-reader')) assert.equal(p.optional, undefined, p.name)

    // SHA256SUMS.txt covers every file the pack writes at the top of the kit, the reader's tarballs included
    const sums = parseSums(readFileSync(join(tmp, 'SHA256SUMS.txt'), 'utf8'))
    const expected = [...manifest.packages.flatMap((p) => [p.archive, p.file]), 'kit-manifest.json', ...manifest.files.map((f) => f.name)].sort()
    assert.deepEqual([...sums.keys()].sort(), expected)
    for (const [name, digest] of sums) assert.equal(createHash('sha256').update(readFileSync(join(tmp, name))).digest('hex'), digest, name)
    assert.ok(sums.has('slicerx-step-reader.tgz') && sums.has(`slicerx-step-reader-${step.version}.tgz`))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('the manifest guide is copied and included by the embedding packages', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sx-kit-docs-'))
  try {
    execFileSync(process.execPath, [resolve(import.meta.dirname, 'copy-integrator-docs.mjs'), tmp])
    const guide = readFileSync(join(tmp, 'kit-manifest.md'), 'utf8')
    assert.match(guide, /schemaVersion: 1/)
    assert.match(readFileSync(join(tmp, 'quickstart.md'), 'utf8'), /\(kit-manifest\.md\)/)
    for (const p of kitPackages().filter((p) => p.name === '@slicerx/embed' || p.name === '@slicerx/mcp')) {
      assert.ok(p.files.includes('kit-manifest.md'), `${p.name} must pack the linked guide`)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('the kit ships the settings defaults byte for byte and lists them in the manifest', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sx-kit-defaults-'))
  try {
    const packages = kitPackages().map(({ name, version }) => ({ name, version }))
    for (const p of packages) writeFileSync(join(tmp, `${p.name.replace('@', '').replace('/', '-')}-${p.version}.tgz`), p.name)
    writePackageManifest(tmp, packages)
    const source = readFileSync(resolve(import.meta.dirname, '..', 'packages', 'settings', 'defaults.json'))
    const shipped = readFileSync(join(tmp, 'defaults.json'))
    assert.ok(shipped.equals(source), 'defaults.json in the kit must equal packages/settings/defaults.json')
    const manifest = JSON.parse(readFileSync(join(tmp, 'kit-manifest.json'), 'utf8'))
    assert.equal(manifest.schemaVersion, 1)
    assert.equal(manifest.packages.length, 4)
    assert.deepEqual(manifest.files, [{ name: 'defaults.json', sha256: createHash('sha256').update(source).digest('hex') }])
    // every entry is [scope, value] and nothing else
    for (const [key, entry] of Object.entries(JSON.parse(source.toString('utf8')))) {
      assert.ok(Array.isArray(entry) && entry.length === 2, key)
      assert.ok(['process', 'printer', 'filament'].includes(entry[0]), key)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('a pack leaves no untracked docs in the packages: every doc copied before packing is git-ignored', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sx-kit-ignored-'))
  try {
    execFileSync(process.execPath, [resolve(import.meta.dirname, 'copy-integrator-docs.mjs'), tmp])
    const copied = readdirSync(tmp)
    assert.ok(copied.length > 0)
    const repo = resolve(import.meta.dirname, '..')
    for (const pkg of ['packages/mcp', 'packages/embed']) {
      for (const f of copied) {
        const r = spawnSync('git', ['check-ignore', '-q', `${pkg}/${f}`], { cwd: repo })
        assert.equal(r.status, 0, `${pkg}/${f} is written by the pack but not in ${pkg}/.gitignore`)
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

/** Every path under `dir`, relative, folders ending in `/`. */
const tree = (dir, prefix = '') => readdirSync(dir).flatMap((n) =>
  statSync(join(dir, n)).isDirectory() ? [`${prefix}${n}/`, ...tree(join(dir, n), `${prefix}${n}/`)] : [`${prefix}${n}`])

test('--zip-assets writes a reproducible assets zip with one top folder, listed in SHA256SUMS.txt', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sx-kit-zip-'))
  try {
    const version = kitPackages().find((p) => p.name === '@slicerx/mcp').version
    const top = `slicerx-kit-assets-${version}`
    const sha = []
    for (const kit of ['a', 'b']) {
      const r = spawnSync(process.execPath, [script, join(tmp, kit), '--assets-only', '--zip-assets'], { encoding: 'utf8', timeout: 120_000 })
      assert.equal(r.status, 0, r.stderr)
      sha.push(createHash('sha256').update(readFileSync(join(tmp, kit, `${top}.zip`))).digest('hex'))
    }
    assert.equal(sha[0], sha[1], 'two packs of one commit give the same zip')

    const kit = join(tmp, 'a')
    const sums = readFileSync(join(kit, 'SHA256SUMS.txt'), 'utf8')
    assert.ok(sums.split('\n').includes(`${sha[0]}  ${top}.zip`), sums)

    // unpack with the system's tools, as an integrator would: bsdtar reads zips, GNU tar does not
    const out = join(tmp, 'unzipped')
    mkdirSync(out)
    try {
      execFileSync('tar', ['-xf', join('..', 'a', `${top}.zip`)], { cwd: out, stdio: 'ignore' })
    } catch {
      execFileSync('unzip', ['-q', join(kit, `${top}.zip`), '-d', out], { stdio: 'inherit' })
    }
    assert.deepEqual(readdirSync(out), [top])
    const assets = join(kit, 'assets')
    const files = tree(assets).sort()
    assert.deepEqual(tree(join(out, top)).sort(), files)
    for (const f of files.filter((f) => !f.endsWith('/'))) assert.ok(readFileSync(join(out, top, f)).equals(readFileSync(join(assets, f))), f)
    for (const f of ['example.css', 'example.html', 'icons/', 'loops/', 'manifest.json', 'tokens.css', 'tool-icons/']) assert.ok(files.includes(f), f)
    assert.ok(!files.some((f) => f.startsWith('credit-kit')))

    // the end record's entry count: the top folder plus every folder and file under assets/
    const zip = readFileSync(join(kit, `${top}.zip`))
    assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50)
    assert.equal(zip.readUInt16LE(zip.length - 12), files.length + 1)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('adding the assets zip keeps every line a full pack wrote in SHA256SUMS.txt', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'sx-kit-zipsums-'))
  try {
    const packages = kitPackages().map(({ name, version }) => ({ name, version }))
    for (const p of packages) writeFileSync(join(tmp, `${stemOf(p.name)}-${p.version}.tgz`), p.name)
    writePackageManifest(tmp, packages)
    const before = parseSums(readFileSync(join(tmp, 'SHA256SUMS.txt'), 'utf8'))
    writeFileSync(join(tmp, 'slicerx-kit-assets-9.9.9.zip'), 'zip')
    addToSums(tmp, ['slicerx-kit-assets-9.9.9.zip'])
    const after = parseSums(readFileSync(join(tmp, 'SHA256SUMS.txt'), 'utf8'))
    assert.equal(after.size, before.size + 1)
    for (const [name, digest] of before) assert.equal(after.get(name), digest, name)
    assert.equal(after.get('slicerx-kit-assets-9.9.9.zip'), createHash('sha256').update('zip').digest('hex'))
    assert.deepEqual([...after.keys()], [...after.keys()].sort())
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
