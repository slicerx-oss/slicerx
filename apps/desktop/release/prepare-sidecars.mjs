// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Release build step: puts the MCP server and the print watch where the Tauri bundle expects them.
//   node apps/desktop/release/prepare-sidecars.mjs --target <rust triple | universal-apple-darwin> [--config <edition.conf.json>]
// - the MCP server, standalone, into src-tauri/resources/mcp (bundled as Resources/mcp/slicerx-mcp.mjs)
// - sx-watch, built release, into src-tauri/binaries/sx-watch-<triple> (the Tauri sidecar naming)
// - the SigLIP2 model, when SX_WATCH_MODEL_URL is set (a release asset, never in git; SX_WATCH_MODEL_SHA256 is checked)
// With --config the edition's Tauri config gets bundle.externalBin and the model as a resource. The model is
// optional: without it the watch is left out of the bundle, since a watch with no model reports nothing.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..', '..')
const tauri = join(repo, 'apps', 'desktop', 'src-tauri')
const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const target = arg('--target')
if (!target) throw new Error('--target is required')
const configPath = arg('--config')
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: repo, stdio: 'inherit', ...opts })

run('node', [join(repo, 'packages', 'mcp', 'scripts', 'build.mjs'), '--standalone', join(tauri, 'resources', 'mcp')])

const model = join(tauri, 'resources', 'sx-watch-siglip2.onnx')
const url = process.env.SX_WATCH_MODEL_URL
if (url && !existsSync(model)) {
  if (!url.startsWith('https://')) throw new Error('SX_WATCH_MODEL_URL must be https')
  run('curl', ['--fail', '--silent', '--show-error', '--location', '--output', model, url])
}
const haveModel = existsSync(model)
if (haveModel && process.env.SX_WATCH_MODEL_SHA256) {
  const sum = createHash('sha256').update(readFileSync(model)).digest('hex')
  if (sum !== process.env.SX_WATCH_MODEL_SHA256.toLowerCase()) throw new Error('The watch model does not match SX_WATCH_MODEL_SHA256')
}

// Without the model the watch is not bundled, so it is not built either. ONNX Runtime ships no x86_64 macOS binary,
// so a universal build carries an arm64 watch, and the app leaves it off on Intel Macs.
if (haveModel) {
  const exe = target.includes('windows') ? '.exe' : ''
  mkdirSync(join(tauri, 'binaries'), { recursive: true })
  const built = (triple) => join(resolve(repo, process.env.CARGO_TARGET_DIR ?? 'target'), triple, 'release', `sx-watch${exe}`)
  if (target === 'universal-apple-darwin') {
    run('cargo', ['build', '--release', '-p', 'sx-watch', '--target', 'aarch64-apple-darwin'])
    // tauri-build checks each externalBin under every arch triple of a universal build; only the universal file ships.
    for (const name of [target, 'aarch64-apple-darwin', 'x86_64-apple-darwin']) {
      copyFileSync(built('aarch64-apple-darwin'), join(tauri, 'binaries', `sx-watch-${name}`))
    }
  } else {
    run('cargo', ['build', '--release', '-p', 'sx-watch', '--target', target])
    copyFileSync(built(target), join(tauri, 'binaries', `sx-watch-${target}${exe}`))
  }
}

if (configPath) {
  const conf = JSON.parse(readFileSync(configPath, 'utf8'))
  conf.bundle = { ...conf.bundle }
  if (haveModel) {
    conf.bundle.externalBin = [...new Set([...(conf.bundle.externalBin ?? []), 'binaries/sx-watch'])]
    conf.bundle.resources = { ...(conf.bundle.resources ?? {}), 'resources/sx-watch-siglip2.onnx': 'sx-watch-siglip2.onnx' }
  } else console.log('sx-watch: no model, so the watch is not bundled')
  writeFileSync(configPath, JSON.stringify(conf, null, 2) + '\n')
}
