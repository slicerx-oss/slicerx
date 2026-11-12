// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Release build step: turns the exact kernel on in the edition's Tauri config, for the release legs that ship it.
//   node apps/desktop/release/kernel-config.mjs --config <edition.conf.json> --kernel <dir>
// --kernel is the directory packages/brep/scripts/fetch-smlib.sh printed (the release scripts also pass it to the
// build as SX_SMLIB_DIR, with SX_BREP_REQUIRE=1, so a build without the kernel fails instead of building the stand-in).
// The config gets:
// - build.features with native-geom, which the Tauri CLI passes to cargo (the edition config reaches the CLI through
//   --config in every release path, so this does not depend on how a build step forwards extra arguments)
// - the kernel's license files as resources in licenses/, beside the files every build ships there (tauri.conf.json):
//   NVIDIA's LICENSE as it comes in the kernel's source, its NOTICE when the source has one, and SMLib.txt (this
//   folder's licenses/SMLib.txt) with the notice and the statement of the changes SlicerX makes to the kernel's files.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
export const FEATURE = 'native-geom'
/** The notice SlicerX writes for the kernel, shipped as licenses/SMLib.txt. */
export const NOTICE_FILE = join(here, 'licenses', 'SMLib.txt')

/** Tauri resource paths are written with forward slashes on every system. */
const slash = (p) => p.replaceAll('\\', '/')

/** The license files a build with the kernel at `kernel` ships, as Tauri resources (source path: path in the app). */
export function kernelResources(kernel) {
  const dir = resolve(kernel)
  if (!existsSync(join(dir, 'source', 'SMLib', 'inc'))) throw new Error(`${dir} has no source/SMLib: give the directory packages/brep/scripts/fetch-smlib.sh prints`)
  const license = join(dir, 'LICENSE')
  if (!existsSync(license)) throw new Error(`${license} is missing: the kernel's license must ship with it`)
  const out = { [slash(license)]: 'licenses/SMLib-LICENSE.txt', [slash(NOTICE_FILE)]: 'licenses/SMLib.txt' }
  // Apache-2.0 section 4(d): a NOTICE in the kernel's source ships too
  const notice = join(dir, 'NOTICE')
  if (existsSync(notice)) out[slash(notice)] = 'licenses/SMLib-NOTICE.txt'
  return out
}

/** `conf` (an edition Tauri config) with the kernel turned on. */
export function withKernel(conf, kernel) {
  const features = [...new Set([...(conf.build?.features ?? []), FEATURE])]
  // the bridge is for dev and test builds only (check-agent-bridge.mjs); a release config never asks for it
  if (features.includes('agent-bridge')) throw new Error('the config asks for agent-bridge, which no release build has')
  return {
    ...conf,
    build: { ...conf.build, features },
    bundle: { ...conf.bundle, resources: { ...(conf.bundle?.resources ?? {}), ...kernelResources(kernel) } },
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({ options: { config: { type: 'string' }, kernel: { type: 'string' } }, strict: true })
  if (!values.config || !values.kernel) {
    console.error('usage: kernel-config.mjs --config <edition.conf.json> --kernel <dir>')
    process.exit(2)
  }
  const conf = withKernel(JSON.parse(readFileSync(values.config, 'utf8')), values.kernel)
  writeFileSync(values.config, JSON.stringify(conf, null, 2) + '\n')
  console.log(`kernel: on (${FEATURE}); license files: ${Object.values(kernelResources(values.kernel)).join(', ')}`)
}
