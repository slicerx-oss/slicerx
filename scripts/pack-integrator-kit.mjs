#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Packs the packages an app that builds SlicerX in installs (@slicerx/viewport, @slicerx/embed and
// @slicerx/mcp) into one folder, built, as npm would publish them, with the credit kit
// (docs/integrators/credit-kit) beside them. Use it for a build that is not on npm yet:
//   node scripts/pack-integrator-kit.mjs ~/slicerx-kit
//   npm install ~/slicerx-kit/slicerx-viewport.tgz ~/slicerx-kit/slicerx-embed.tgz ~/slicerx-kit/slicerx-mcp.tgz
//
// With --engine it also lays out the prebuilt engine (sx, sx-geom and sx-link, libslicerx and its header) for
// macOS, Windows and Linux, from an engine release's archives, each checked against the release's SHA256SUMS.txt:
//   node scripts/pack-integrator-kit.mjs ~/slicerx-kit --engine engine-v0.1.6     # a published engine release
//   node scripts/pack-integrator-kit.mjs ~/slicerx-kit --engine ./engine-draft    # a folder of archives (a draft)
// The kit then has engine/macos-universal, engine/windows-x64 and engine/linux-x64, each with bin/, lib/ and include/
// as the archive has them. --engine-only skips the packages (no pnpm build).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportAssets } from './export-kit-assets.mjs'

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

// stable copies work on platforms where extracting symlinks needs extra privileges.
export function writePackageManifest(dest, packages) {
  const entries = packages.map(({ name, version }) => {
    const stem = name.replace('@', '').replace('/', '-')
    const archive = `${stem}-${version}.tgz`
    const file = `${stem}.tgz`
    const bytes = readFileSync(join(dest, archive))
    writeFileSync(join(dest, file), bytes)
    return { name, version, file, archive, sha256: createHash('sha256').update(bytes).digest('hex') }
  })
  const manifest = { schemaVersion: 1, packages: entries }
  writeFileSync(join(dest, 'kit-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export function kitPackages() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  return ['ui/viewport', 'embed', 'mcp'].map((folder) => JSON.parse(readFileSync(join(root, 'packages', folder, 'package.json'), 'utf8')))
}

function packPackages(dest) {
  const metadata = kitPackages()
  const packages = metadata.map((p) => p.name)
  rmSync(join(dest, 'kit-manifest.json'), { force: true })
  for (const f of readdirSync(dest)) if (/^slicerx-(viewport|embed|mcp)(?:-.*)?\.tgz$/.test(f)) rmSync(join(dest, f))
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  for (const p of packages) {
    // pack runs each package's prepack, which builds it.
    execFileSync(pnpm, ['--filter', p, 'pack', '--pack-destination', dest], { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' })
  }
  const manifest = writePackageManifest(dest, metadata)
  const files = manifest.packages.map((p) => p.file)
  // the credit kit is for people, so it sits beside the tarballs rather than in node_modules
  const credit = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'integrators', 'credit-kit')
  rmSync(join(dest, 'credit-kit'), { recursive: true, force: true })
  cpSync(credit, join(dest, 'credit-kit'), { recursive: true })
  console.log(`credit kit: ${join(dest, 'credit-kit')}`)
  console.log(`npm install ${files.map((f) => join(dest, f)).join(' ')}`)
}

async function main(args) {
  const values = new Set(['--engine', '--repo'])
  const dest = resolve(args.find((a, i) => !a.startsWith('--') && !values.has(args[i - 1] ?? '')) ?? 'slicerx-kit')
  const engineSource = flag(args, '--engine')
  const repo = flag(args, '--repo')
  const engineOnly = args.includes('--engine-only')
  const assetsOnly = args.includes('--assets-only')
  if (engineOnly && !engineSource) throw new Error('--engine-only needs --engine <tag | folder>')
  mkdirSync(dest, { recursive: true })
  if (!engineOnly && !assetsOnly) packPackages(dest)
  await exportAssets(join(dest, 'assets'))
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
