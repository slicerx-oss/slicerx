// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Builds the downloads manifest the site reads from a folder of installers.
// Usage: node make-manifest.mjs <dir> --version 0.1.0 --base-url <url> [--out downloads.json]
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { version: { type: 'string' }, 'base-url': { type: 'string' }, out: { type: 'string', default: 'downloads.json' } },
})
const [dir] = positionals
if (!dir || !values.version || !values['base-url']) {
  console.error('usage: make-manifest.mjs <dir> --version <x.y.z> --base-url <url> [--out file]')
  process.exit(2)
}

// Tauri names installers SlicerX_<version>_<arch>[-setup|_<lang>].<ext>.
const kinds = [
  { re: /\.dmg$/i, platform: 'macos', arch: 'universal', format: 'dmg' },
  { re: /-setup\.exe$/i, platform: 'windows', arch: 'x64', format: 'nsis' },
  { re: /\.msi$/i, platform: 'windows', arch: 'x64', format: 'msi' },
  { re: /\.AppImage$/i, platform: 'linux', arch: 'x64', format: 'appimage' },
  { re: /\.deb$/i, platform: 'linux', arch: 'x64', format: 'deb' },
]
const order = ['macos', 'windows', 'linux']

const downloads = readdirSync(dir)
  .flatMap((file) => {
    const kind = kinds.find((k) => k.re.test(file))
    if (!kind) return []
    const path = join(dir, file)
    return [
      {
        platform: kind.platform,
        arch: kind.arch,
        format: kind.format,
        version: values.version,
        file,
        url: `${values['base-url'].replace(/\/$/, '')}/${encodeURIComponent(file)}`,
        sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
        size: statSync(path).size,
      },
    ]
  })
  .sort((a, b) => order.indexOf(a.platform) - order.indexOf(b.platform) || a.format.localeCompare(b.format))

if (downloads.length === 0) {
  console.error(`no installers found in ${dir}`)
  process.exit(1)
}
const manifest = { schema: 1, version: values.version, releasedAt: new Date().toISOString(), downloads }
writeFileSync(values.out, JSON.stringify(manifest, null, 2) + '\n')
console.log(`${values.out}: ${downloads.length} downloads for ${values.version}`)
