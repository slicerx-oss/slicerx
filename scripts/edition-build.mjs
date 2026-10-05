#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Builds an edition from its config file in one command, with no shell variables to set:
//
//   pnpm edition:build editions/<id>/edition.config.ts --target desktop|web [--skip-wasm] [--dry-run]
//
// It checks the config, builds the WebAssembly engine (set SX_WASM_OPT=0 to skip wasm-opt), then builds the
// browser app or the desktop app. The config path goes to every step explicitly, and each child process
// gets SLICERX_CONFIG for the Vite build.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2).filter((a) => a !== '--')
const flag = (name) => args.includes(name)
const option = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--target')
const target = option('--target') ?? 'desktop'

if (!file || !['desktop', 'web'].includes(target)) {
  console.error('usage: pnpm edition:build editions/<id>/edition.config.ts --target desktop|web [--skip-wasm] [--dry-run]')
  process.exit(2)
}
// pnpm runs the script from the repository root; INIT_CWD is where the command was typed
const config = resolve(process.env['INIT_CWD'] ?? process.cwd(), file)
if (!existsSync(config)) {
  console.error(`edition-build: config not found: ${config}`)
  process.exit(1)
}

const cli = join(root, 'packages/edition-config/src/cli.ts')
const steps = [['check the config', 'node', [cli, 'check', config]]]
if (!flag('--skip-wasm')) steps.push(['build the WebAssembly engine', 'pnpm', ['--filter', '@slicerx/slicer', 'build:wasm']])
if (target === 'web') steps.push(['build the browser app', 'pnpm', ['--filter', '@slicerx/web', 'build']])
else {
  // tauri:config with the edition's file, written where `tauri build --config` reads it
  steps.push(['write the desktop config and icons', 'pnpm', ['--filter', '@slicerx/desktop', 'exec', 'node', cli, 'tauri', config, 'desktop', 'src-tauri/gen/edition.conf.json']])
  steps.push(['build the desktop app', 'pnpm', ['--filter', '@slicerx/desktop', 'exec', 'tauri', 'build', '--config', 'src-tauri/gen/edition.conf.json']])
}

const env = { ...process.env, SLICERX_CONFIG: config }
for (const [what, cmd, argv] of steps) {
  console.log(`edition-build: ${what}: ${cmd} ${argv.join(' ')}`)
  if (flag('--dry-run')) continue
  const r = spawnSync(cmd, argv, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) {
    console.error(`edition-build: failed to ${what}`)
    process.exit(r.status ?? 1)
  }
}
