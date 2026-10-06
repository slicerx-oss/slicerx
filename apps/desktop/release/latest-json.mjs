// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Writes latest.json, the update manifest the desktop app's updater reads (src-tauri/src/updates.rs), from a folder
// of update bundles and their signatures.
//   node latest-json.mjs <dir> --version 0.2.0 --base-url <url> --release-url <url> --pubkey <base64> [--notes <file>] [--out latest.json]
// Bundles: the macOS .app.tar.gz, the Windows -setup.exe and .msi, the Linux .AppImage. Each needs its .sig from
// sign-updates.sh, made with the key whose public half is --pubkey and bound to this version and file; anything else
// stops the release. --notes is whats-changed.json or a changed.md; the first five lines, kept short, become the
// dialog's highlights. A .deb in the folder is linked for package installs, which update through their package manager.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

/** Update bundles by file name, and the updater targets each serves (`{os}-{arch}` and `{os}-{arch}-{installer}`). */
// An MSI install looks for its own target first, so it never runs the NSIS setup over itself.
export const BUNDLES = [
  { re: /\.app\.tar\.gz$/i, platforms: ['darwin-aarch64', 'darwin-x86_64'] },
  { re: /-setup\.exe$/i, platforms: ['windows-x86_64'] },
  { re: /\.msi$/i, platforms: ['windows-x86_64-msi'] },
  { re: /\.AppImage$/i, platforms: ['linux-x86_64'] },
]
export const NOTE_LINES = 5
export const NOTE_CHARS = 100

/** Cuts a line at a word boundary to at most `max` characters, with an ellipsis (packages/app/src/updates/updates.ts). */
export function shorten(line, max = NOTE_CHARS) {
  if (line.length <= max) return line
  const cut = line.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}…`
}

/** The highlights from whats-changed.json (its notes) or a markdown list: list marks and headings dropped, five, short. */
export function topNotes(source) {
  const lines = typeof source === 'string' ? source.split(/\r?\n/) : (source?.notes ?? []).map((n) => n.note ?? '')
  return lines
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('**'))
    .slice(0, NOTE_LINES)
    .map((l) => shorten(l))
}

/** The two lines of a minisign text (public key or signature) that `tauri signer` base64 encodes once more. */
function minisign(b64) {
  return Buffer.from(b64.trim(), 'base64').toString('utf8').split('\n').map((l) => l.trim())
}

/** The key id a public key or a signature names: bytes 2 to 10 of its key line, as hex. */
export function keyId(b64) {
  const line = minisign(b64).find((l) => l && !l.startsWith('untrusted comment:') && !l.startsWith('trusted comment:'))
  const raw = line ? Buffer.from(line, 'base64') : Buffer.alloc(0)
  if (raw.length < 10) throw new Error('not a minisign key or signature')
  return raw.subarray(2, 10).toString('hex')
}

/** The fields of a signature's trusted comment (timestamp, file, version). */
export function signedFields(sig) {
  const line = minisign(sig).find((l) => l.startsWith('trusted comment:')) ?? ''
  return Object.fromEntries(line.slice('trusted comment:'.length).trim().split('\t').map((f) => [f.slice(0, f.indexOf(':')), f.slice(f.indexOf(':') + 1)]))
}

/**
 * The manifest for `files` (name to signature text, null for a bundle with none). Throws on a missing signature, one
 * made with another key, or one bound to another file or version.
 */
export function latestJson({ version, files, baseUrl, releaseUrl, pubkey, notes = [], date = new Date() }) {
  const want = keyId(pubkey)
  const platforms = {}
  let deb = null
  for (const [file, sig] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const url = `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(file)}`
    if (/\.deb$/i.test(file)) deb = url
    const kind = BUNDLES.find((b) => b.re.test(file))
    if (!kind) continue
    if (!sig) throw new Error(`${file} has no .sig: run sign-updates.sh on the release Mac first`)
    if (keyId(sig) !== want) throw new Error(`${file}.sig was made with another key (${keyId(sig)}), not the one in the edition config (${want})`)
    const signed = signedFields(sig)
    if (signed.file !== file) throw new Error(`${file}.sig signs ${signed.file ?? 'another file'}`)
    if (signed.version !== version) throw new Error(`${file}.sig is for version ${signed.version ?? '(none)'}, not ${version}`)
    for (const p of kind.platforms) {
      if (platforms[p]) throw new Error(`two bundles for ${p}: ${file} and ${decodeURIComponent(platforms[p].url.split('/').pop())}`)
      platforms[p] = { url, signature: sig.trim() }
    }
  }
  if (!Object.keys(platforms).length) throw new Error('no update bundles (.app.tar.gz, -setup.exe, .msi, .AppImage)')
  return {
    version,
    notes: notes.join('\n'),
    pub_date: date.toISOString(),
    release_url: releaseUrl,
    ...(deb ? { deb_url: deb } : {}),
    platforms,
  }
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { version: { type: 'string' }, 'base-url': { type: 'string' }, 'release-url': { type: 'string' }, pubkey: { type: 'string' }, notes: { type: 'string' }, out: { type: 'string', default: 'latest.json' } },
  })
  const [dir] = positionals
  if (!dir || !values.version || !values['base-url'] || !values['release-url'] || !values.pubkey) {
    console.error('usage: latest-json.mjs <dir> --version <x.y.z> --base-url <url> --release-url <url> --pubkey <base64> [--notes file] [--out file]')
    process.exit(2)
  }
  const names = readdirSync(dir)
  const files = Object.fromEntries(
    names.filter((f) => !f.endsWith('.sig') && (BUNDLES.some((b) => b.re.test(f)) || /\.deb$/i.test(f))).map((f) => [f, names.includes(`${f}.sig`) ? readFileSync(join(dir, `${f}.sig`), 'utf8') : null]),
  )
  const text = values.notes ? readFileSync(values.notes, 'utf8') : ''
  const notes = values.notes ? topNotes(values.notes.endsWith('.json') ? JSON.parse(text) : text) : []
  const manifest = latestJson({ version: values.version, files, baseUrl: values['base-url'], releaseUrl: values['release-url'], pubkey: values.pubkey, notes })
  writeFileSync(values.out, JSON.stringify(manifest, null, 2) + '\n')
  const missing = ['darwin-aarch64', 'windows-x86_64', 'linux-x86_64'].filter((p) => !manifest.platforms[p])
  console.log(`${values.out}: ${values.version} for ${Object.keys(manifest.platforms).length} targets, ${notes.length} highlights${missing.length ? `; no update for ${missing.join(', ')}` : ''}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main()
  } catch (e) {
    console.error(`latest-json: ${e.message}`)
    process.exit(1)
  }
}
