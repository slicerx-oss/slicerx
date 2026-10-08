// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Builds a test build of the desktop app with the agent bridge (docs/agent-bridge.md): the shell with the
// `agent-bridge` Cargo feature and the page with SLICERX_AGENT_BRIDGE=1. Never a release: no installers and no
// signing, into its own Cargo target folder (target/agent-bridge), and the release scripts refuse a bridge build.
// It gets its own identifier (the edition's plus .agent-bridge), so it keeps its own data folder, web profile, paired
// printers and single-instance lock, and runs next to an installed copy without reading or changing its state.
//   node apps/desktop/scripts/bridge-build.mjs [--debug] [--target <triple>] [--same-identifier]
// The app is target/agent-bridge/[<triple>/]release/slicerx(.exe), or debug/ with --debug. The engine's WASM module and
// the CAD module are not built here; build them first (as the release scripts do) when a run needs the browser engine
// fallback or the CAD tools. The edition config comes from SLICERX_CONFIG and the SLICERX_* variables as for any build;
// without SLICERX_SUPABASE_URL the Vault runs on demo data and nothing reaches a backend.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const desktop = resolve(import.meta.dirname, '..')
const repo = resolve(desktop, '../..')
// `pnpm ... build:bridge -- --debug` hands the script a literal `--` first (pnpm 10), which parseArgs would take as the
// end of the options; it is dropped.
const argv = process.argv.slice(2)
const { values } = parseArgs({ args: argv[0] === '--' ? argv.slice(1) : argv, options: { debug: { type: 'boolean' }, target: { type: 'string' }, 'same-identifier': { type: 'boolean' } }, strict: true })

const env = { ...process.env, SLICERX_AGENT_BRIDGE: '1', CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || join(repo, 'target', 'agent-bridge') }
// On Windows pnpm is a .cmd script, which only a shell starts; the arguments are this script's own, without spaces.
const run = (args) => {
  const r = process.platform === 'win32' ? spawnSync(['pnpm', ...args].join(' '), { cwd: desktop, env, stdio: 'inherit', shell: true }) : spawnSync('pnpm', args, { cwd: desktop, env, stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

run(['tauri:config'])
const conf = JSON.parse(readFileSync(join(desktop, 'src-tauri', 'gen', 'edition.conf.json'), 'utf8'))
if (!values['same-identifier']) conf.identifier = `${conf.identifier}.agent-bridge`
writeFileSync(join(desktop, 'src-tauri', 'gen', 'edition.bridge.conf.json'), `${JSON.stringify(conf, null, 2)}
`)
run(['tauri', 'build', '--config', 'src-tauri/gen/edition.bridge.conf.json', '--features', 'agent-bridge', '--no-bundle', ...(values.debug ? ['--debug'] : []), ...(values.target ? ['--target', values.target] : [])])
const bin = join(env.CARGO_TARGET_DIR, ...(values.target ? [values.target] : []), values.debug ? 'debug' : 'release', process.platform === 'win32' ? 'slicerx.exe' : 'slicerx')
console.log(`agent bridge build: ${bin} (identifier ${conf.identifier})`)
console.log('start it with SX_AGENT_BRIDGE_PORT=0 (and SX_AGENT_BRIDGE_TOKEN_FILE=<path> to choose where the token goes)')
