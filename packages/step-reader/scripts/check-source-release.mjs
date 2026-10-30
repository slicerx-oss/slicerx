// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Runs before `pnpm publish` (prepublishOnly): the LGPL source offer in SOURCE.md promises the complete source of the
// wasm next to every published version, so publishing stops unless the GitHub release step-reader-v<version> already
// has occt-import-js-source-<occt-import-js version>.tar.gz attached. Make it with source-archive.sh, create the
// release, attach the archive, then publish.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The archive source-archive.sh writes, by the name it gives it. */
export function sourceArchiveName() {
  const script = readFileSync(join(pkg, 'source-archive.sh'), 'utf8')
  const m = /^name=(\S+)$/m.exec(script)
  if (!m) throw new Error('source-archive.sh names no archive')
  return `${m[1]}.tar.gz`
}

/** Where the archive must be for this version: an asset of the release tagged step-reader-v<version>. */
export function sourceArchiveUrl(version, repository = 'https://github.com/slicerx-oss/slicerx') {
  return `${repository}/releases/download/step-reader-v${version}/${sourceArchiveName()}`
}

/** Resolves when the archive is downloadable; rejects with the reason otherwise. */
export async function checkSourceRelease(version, doFetch = fetch) {
  const url = sourceArchiveUrl(version)
  let res
  try {
    // One byte is enough to know the asset is there; GitHub redirects release downloads to its file storage.
    res = await doFetch(url, { method: 'GET', redirect: 'follow', headers: { range: 'bytes=0-0' }, signal: AbortSignal.timeout(30_000) })
  } catch (e) {
    throw new Error(`could not reach ${url}: ${e instanceof Error ? e.message : String(e)}`)
  }
  await res.body?.cancel()
  if (res.status !== 200 && res.status !== 206) {
    throw new Error(`the source archive is not on the release (HTTP ${res.status} for ${url}). Create the GitHub release step-reader-v${version}, attach the archive source-archive.sh writes, then publish.`)
  }
  return url
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { version } = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'))
  try {
    const url = await checkSourceRelease(version)
    console.log(`check-source-release: ${url} is there`)
  } catch (e) {
    console.error(`check-source-release: publishing stopped: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}
