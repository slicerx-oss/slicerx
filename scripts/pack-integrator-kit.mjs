#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Packs the packages an app that builds SlicerX in installs (@slicerx/viewport, @slicerx/embed and
// @slicerx/mcp) into one folder, built, as npm would publish them, with the credit kit
// (docs/integrators/credit-kit) and every setting's default (defaults.json) beside them. The optional STEP reader
// (@slicerx/step-reader, OpenCASCADE in wasm with its license texts and source offer) is its own tarball, installed
// only by apps that read STEP files. SHA256SUMS.txt lists every tarball and file the pack writes at the top. Use it
// for a build that is not on npm yet:
//   node scripts/pack-integrator-kit.mjs ~/slicerx-kit
//   npm install ~/slicerx-kit/slicerx-viewport.tgz ~/slicerx-kit/slicerx-embed.tgz ~/slicerx-kit/slicerx-mcp.tgz
//   npm install ~/slicerx-kit/slicerx-step-reader.tgz     # only to read STEP files
//
// With --engine it also lays out the prebuilt engine (sx, sx-geom and sx-link, libslicerx and its header) for
// macOS, Windows and Linux, from an engine release's archives, each checked against the release's SHA256SUMS.txt:
//   node scripts/pack-integrator-kit.mjs ~/slicerx-kit --engine engine-v0.2.7     # a published engine release
//   node scripts/pack-integrator-kit.mjs ~/slicerx-kit --engine ./engine-draft    # a folder of archives (a draft)
// The kit then has engine/macos-universal, engine/windows-x64 and engine/linux-x64, each with bin/, lib/ and include/
// as the archive has them. --engine-only skips the packages (no pnpm build).
//
// The tooltip loops in assets/ are transparent. --backdrop draws the studio gradient behind them, and
// --edition <edition.json> colors tokens.css and the SVG fallbacks from that edition's brand.theme block.
//
// --zip-assets also writes slicerx-kit-assets-<kit version>.zip beside the kit, one folder
// slicerx-kit-assets-<kit version>/ holding the contents of assets/, and lists it in SHA256SUMS.txt. The zip is
// reproducible: sorted entries and one fixed time (SOURCE_DATE_EPOCH, else the HEAD commit's), so two packs of one
// commit give the same bytes.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'
import { exportAssets, readEdition } from './export-kit-assets.mjs'

const REPO = 'slicerx-oss/slicerx'
/** The platforms an engine release builds, by the suffix of its archive names. */
export const PLATFORMS = ['macos-universal', 'windows-x64', 'linux-x64']

/** `SHA256SUMS.txt` as `name -> hex digest`. */
export function parseSums(text) {
  const out = new Map()
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line)
    if (m) out.set(m[2], m[1].toLowerCase())
  }
  return out
}

/** The platform an engine archive is for, from its name (`slicerx-engine-0.1.3-macos-universal.tar.gz`). */
export function platformOf(name) {
  const m = /^slicerx-engine-.+-(macos-universal|windows-x64|linux-x64)\.(tar\.gz|zip)$/.exec(name)
  return m ? m[1] : undefined
}

/** The kit's engine folder for this machine (`macos-universal`, `windows-x64`, `linux-x64`), if a release builds one. */
export function hostPlatform(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') return 'macos-universal'
  if (platform === 'win32' && arch === 'x64') return 'windows-x64'
  if (platform === 'linux' && arch === 'x64') return 'linux-x64'
  return undefined
}

/**
 * The engine archives of `source`, a release tag (downloaded from GitHub) or a folder (a draft release's files), each
 * checked against the release's SHA256SUMS.txt. Fails when a digest does not match or an archive the sums list is
 * missing.
 */
export async function engineArchives(source, opts = {}) {
  const fromDir = existsSync(source) && statSync(source).isDirectory()
  const get = async (name) => {
    if (fromDir) return readFileSync(join(source, name))
    const url = `https://github.com/${opts.repo ?? REPO}/releases/download/${encodeURIComponent(source)}/${name}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`)
    return Buffer.from(await res.arrayBuffer())
  }
  const sums = parseSums((await get('SHA256SUMS.txt')).toString('utf8'))
  const archives = [...sums.keys()].filter((n) => platformOf(n))
  if (archives.length === 0) throw new Error(`${source}: SHA256SUMS.txt lists no engine archives`)
  const out = []
  for (const name of archives) {
    const bytes = await get(name)
    const got = createHash('sha256').update(bytes).digest('hex')
    if (got !== sums.get(name)) throw new Error(`${name}: SHA-256 ${got} does not match SHA256SUMS.txt (${sums.get(name)})`)
    out.push({ name, platform: platformOf(name), bytes })
  }
  return out
}

/** Unpacks each archive into `<dest>/engine/<platform>/`, without the archive's own top folder. */
export function layOutEngine(archives, dest, label) {
  const engine = join(dest, 'engine')
  rmSync(engine, { recursive: true, force: true })
  const work = join(dest, '.engine-unpack')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  const sums = []
  for (const a of archives) {
    const file = join(work, a.name)
    writeFileSync(file, a.bytes)
    const into = join(work, a.platform)
    mkdirSync(into, { recursive: true })
    unpack(file, into)
    // the archive holds one folder, slicerx-engine-<version>-<platform>/
    const top = readdirSync(into)
    const root = top.length === 1 && statSync(join(into, top[0])).isDirectory() ? join(into, top[0]) : into
    mkdirSync(engine, { recursive: true })
    renameSync(root, join(engine, a.platform))
    sums.push(`${createHash('sha256').update(a.bytes).digest('hex')}  ${a.name}`)
  }
  rmSync(work, { recursive: true, force: true })
  writeFileSync(join(engine, 'SOURCE.txt'), `${label}\n\n${sums.join('\n')}\n`)
  return engine
}

function unpack(file, into) {
  // tar runs in the archive's folder with relative paths: GNU tar (Git for Windows, MSYS2) reads a drive letter in
  // C:\path as a remote host, and its --force-local is not a bsdtar option
  const cwd = dirname(file)
  const local = ['-f', basename(file), '-C', relative(cwd, into) || '.']
  if (file.endsWith('.tar.gz')) return execFileSync('tar', ['-xz', ...local], { cwd, stdio: 'inherit' })
  // bsdtar (macOS, Windows) reads zip archives; GNU tar does not, so Linux uses unzip
  try {
    execFileSync('tar', ['-x', ...local], { cwd, stdio: 'ignore' })
  } catch {
    execFileSync('unzip', ['-q', '-o', file, '-d', into], { stdio: 'inherit' })
  }
}

function flag(args, name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

/**
 * Plain files the kit ships at its top level, copied byte for byte: `defaults.json` is every setting's scope and
 * default value (`{ key: [scope, value] }`), the same file the app and the engine read.
 */
export const KIT_FILES = [{ name: 'defaults.json', from: ['packages', 'settings', 'defaults.json'] }]

/** Copies KIT_FILES into `dest` and returns each one's `name` and `sha256`, for the manifest's `files`. */
export function writeKitFiles(dest) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  return KIT_FILES.map(({ name, from }) => {
    const bytes = readFileSync(join(root, ...from))
    writeFileSync(join(dest, name), bytes)
    return { name, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
}

/** Packages an app installs only for one feature; the manifest marks them `optional: true`. */
export const OPTIONAL_PACKAGES = new Set(['@slicerx/step-reader'])

// stable copies work on platforms where extracting symlinks needs extra privileges.
export function writePackageManifest(dest, packages) {
  const entries = packages.map(({ name, version }) => {
    const stem = name.replace('@', '').replace('/', '-')
    const archive = `${stem}-${version}.tgz`
    const file = `${stem}.tgz`
    const bytes = readFileSync(join(dest, archive))
    writeFileSync(join(dest, file), bytes)
    const entry = { name, version, file, archive, sha256: createHash('sha256').update(bytes).digest('hex') }
    return OPTIONAL_PACKAGES.has(name) ? { ...entry, optional: true } : entry
  })
  const manifest = { schemaVersion: 1, packages: entries, files: writeKitFiles(dest) }
  writeFileSync(join(dest, 'kit-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeSums(dest, [...entries.flatMap((e) => [e.archive, e.file]), 'kit-manifest.json', ...manifest.files.map((f) => f.name)])
  return manifest
}

/** Writes `SHA256SUMS.txt` for `names` (files in `dest`), in the format `sha256sum` writes and `parseSums` reads. */
export function writeSums(dest, names) {
  const lines = [...names].sort().map((n) => `${createHash('sha256').update(readFileSync(join(dest, n))).digest('hex')}  ${n}`)
  writeFileSync(join(dest, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`)
}

/** Adds `names` (files in `dest`) to `SHA256SUMS.txt`, keeping the lines already there, and writes it sorted. */
export function addToSums(dest, names) {
  const file = join(dest, 'SHA256SUMS.txt')
  const kept = existsSync(file) ? [...parseSums(readFileSync(file, 'utf8')).keys()] : []
  writeSums(dest, new Set([...kept, ...names]))
}

/** Every path under `dir`, relative and with `/`, folders ending in `/`, in code unit order (a folder before its files). */
function walk(dir, prefix = '') {
  const out = []
  for (const name of readdirSync(dir)) {
    const rel = `${prefix}${name}`
    if (statSync(join(dir, name)).isDirectory()) out.push(`${rel}/`, ...walk(join(dir, name), `${rel}/`))
    else out.push(rel)
  }
  return out.sort()
}

/** `seconds` since the epoch as a zip (MS-DOS) time and date, read in UTC so every machine writes the same bytes. */
function dosTime(seconds) {
  const d = new Date(Math.max(seconds, 315532800) * 1000) // 1980-01-01, the first time a zip can hold
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  }
}

/**
 * Zips the contents of `dir` into `out` under one folder `top/`, with Node's own deflate (no zip tool on PATH needed;
 * Windows has none). The bytes depend only on the files and `seconds`: entries are sorted, every entry gets the same
 * time, and the modes are fixed (folders 755, files 644). Returns the number of entries, folders included.
 */
export function zipFolder(dir, out, top, seconds) {
  const { time, date } = dosTime(seconds)
  const names = [`${top}/`, ...walk(dir).map((p) => `${top}/${p}`)]
  if (names.length > 0xffff) throw new Error(`${out}: ${names.length} entries is more than a zip without zip64 holds`)
  const locals = [], central = []
  let offset = 0
  for (const name of names) {
    const folder = name.endsWith('/')
    const raw = folder ? Buffer.alloc(0) : readFileSync(join(dir, name.slice(top.length + 1)))
    const packed = folder ? raw : deflateRawSync(raw, { level: 9 })
    const method = folder ? 0 : 8
    const crc = folder ? 0 : crc32(raw)
    const path = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed: 2.0, deflate
    local.writeUInt16LE(0x0800, 6) // names are UTF-8
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(path.length, 26)
    locals.push(local, path, packed)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(0x0314, 4) // made by: Unix, 2.0, so unzip reads the modes below
    local.copy(entry, 6, 4, 26) // version needed through uncompressed size
    entry.writeUInt16LE(path.length, 28)
    entry.writeUInt32LE((((folder ? 0o40755 : 0o100644) << 16) | (folder ? 0x10 : 0)) >>> 0, 38)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, path)
    offset += local.length + path.length + packed.length
    if (offset > 0xffffffff) throw new Error(`${out}: more than 4 GB is more than a zip without zip64 holds`)
  }
  const dirBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(names.length, 8)
  end.writeUInt16LE(names.length, 10)
  end.writeUInt32LE(dirBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  writeFileSync(out, Buffer.concat([...locals, dirBytes, end]))
  return names.length
}

/** The time a reproducible archive carries: SOURCE_DATE_EPOCH when set, else the HEAD commit's, else 1980-01-01. */
export function sourceDate(env = process.env) {
  if (/^\d+$/.test(env.SOURCE_DATE_EPOCH ?? '')) return Number(env.SOURCE_DATE_EPOCH)
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  try {
    return Number(execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) || 0
  } catch {
    return 0
  }
}

/** Writes `slicerx-kit-assets-<version>.zip` in `dest` from `<dest>/assets` and lists it in SHA256SUMS.txt. */
export function zipAssets(dest, version, seconds = sourceDate()) {
  const top = `slicerx-kit-assets-${version}`
  const file = `${top}.zip`
  const entries = zipFolder(join(dest, 'assets'), join(dest, file), top, seconds)
  addToSums(dest, [file])
  return { file, entries }
}

export function kitPackages() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  return ['ui/viewport', 'embed', 'mcp', 'step-reader'].map((folder) => JSON.parse(readFileSync(join(root, 'packages', folder, 'package.json'), 'utf8')))
}

function packPackages(dest) {
  const metadata = kitPackages()
  const packages = metadata.map((p) => p.name)
  for (const f of ['kit-manifest.json', 'SHA256SUMS.txt']) rmSync(join(dest, f), { force: true })
  for (const { name } of KIT_FILES) rmSync(join(dest, name), { force: true })
  for (const f of readdirSync(dest)) if (/^slicerx-(viewport|embed|mcp|step-reader)(?:-.*)?\.tgz$/.test(f)) rmSync(join(dest, f))
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  for (const p of packages) {
    // pack runs each package's prepack, which builds it.
    execFileSync(pnpm, ['--filter', p, 'pack', '--pack-destination', dest], { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' })
  }
  const manifest = writePackageManifest(dest, metadata)
  const files = manifest.packages.filter((p) => !p.optional).map((p) => p.file)
  // the credit kit is for people, so it sits beside the tarballs rather than in node_modules
  const credit = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'integrators', 'credit-kit')
  rmSync(join(dest, 'credit-kit'), { recursive: true, force: true })
  cpSync(credit, join(dest, 'credit-kit'), { recursive: true })
  console.log(`credit kit: ${join(dest, 'credit-kit')}`)
  console.log(`npm install ${files.map((f) => join(dest, f)).join(' ')}`)
  for (const p of manifest.packages.filter((p) => p.optional)) console.log(`optional, to read STEP files: npm install ${join(dest, p.file)}`)
}

async function main(args) {
  const values = new Set(['--engine', '--repo', '--edition'])
  const dest = resolve(args.find((a, i) => !a.startsWith('--') && !values.has(args[i - 1] ?? '')) ?? 'slicerx-kit')
  const engineSource = flag(args, '--engine')
  const repo = flag(args, '--repo')
  const engineOnly = args.includes('--engine-only')
  const assetsOnly = args.includes('--assets-only')
  if (engineOnly && !engineSource) throw new Error('--engine-only needs --engine <tag | folder>')
  mkdirSync(dest, { recursive: true })
  if (!engineOnly && !assetsOnly) packPackages(dest)
  const editionFile = flag(args, '--edition')
  await exportAssets(join(dest, 'assets'), { backdrop: args.includes('--backdrop'), edition: editionFile ? readEdition(editionFile) : undefined })
  if (args.includes('--zip-assets')) {
    const version = kitPackages().find((p) => p.name === '@slicerx/mcp').version
    const { file, entries } = zipAssets(dest, version)
    console.log(`assets zip: ${join(dest, file)} (${entries} entries), listed in SHA256SUMS.txt`)
  }
  if (!engineSource) return
  const archives = await engineArchives(engineSource, repo ? { repo } : {})
  const label = existsSync(engineSource)
    ? `Engine archives from ${resolve(engineSource)}`
    : `Engine release ${engineSource}: https://github.com/${repo ?? REPO}/releases/tag/${engineSource}`
  const engine = layOutEngine(archives, dest, label)
  console.log(`engine: ${engine} (${archives.map((a) => a.platform).join(', ')}), each checked against SHA256SUMS.txt`)
  const here = hostPlatform()
  if (here && archives.some((a) => a.platform === here)) console.log(`this machine's sx: ${join(engine, here, 'bin', here.startsWith('windows') ? 'sx.exe' : 'sx')}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`pack-integrator-kit: ${e.message}`)
    process.exit(1)
  })
}
