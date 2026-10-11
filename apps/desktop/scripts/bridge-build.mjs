// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// Builds a test build of the desktop app with the agent bridge (docs/agent-bridge.md): the shell with the
// `agent-bridge` Cargo feature and the page with SLICERX_AGENT_BRIDGE=1. Never a release: no installers and no
// signing, into its own Cargo target folder (target/agent-bridge), and the release scripts refuse a bridge build.
// It gets its own identifier (the edition's plus .agent-bridge), so it keeps its own data folder, web profile (on macOS
// a web data store named from it), paired printers and single-instance lock, and runs next to an installed copy without reading or changing its state.
//   node apps/desktop/scripts/bridge-build.mjs [--debug] [--target <triple>] [--same-identifier] [--no-geom]
// The app is target/agent-bridge/[<triple>/]release/slicerx(.exe), or debug/ with --debug. The geometry engine's WASM
// (packages/geom/wasm/scripts/build.sh) is built first, as the release scripts do: opening a model runs its repair and
// fit check, and an app without it opens models with neither and says nothing, so a build made without it times and
// measures something no one ships. --no-geom skips it, for a build that only needs the shell. The engine's own WASM
// module is not built here; build it first when a run needs the browser engine fallback. The edition config comes
// from SLICERX_CONFIG and the SLICERX_* variables as for any build; without SLICERX_SUPABASE_URL the Vault runs on demo
// data and nothing reaches a backend.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const desktop = resolve(import.meta.dirname, '..')
const repo = resolve(desktop, '../..')
// `pnpm ... build:bridge -- --debug` hands the script a literal `--` first (pnpm 10), which parseArgs would take as the
// end of the options; it is dropped.
const argv = process.argv.slice(2)
const { values } = parseArgs({ args: argv[0] === '--' ? argv.slice(1) : argv, options: { debug: { type: 'boolean' }, target: { type: 'string' }, 'same-identifier': { type: 'boolean' }, 'no-geom': { type: 'boolean' } }, strict: true })

const env = { ...process.env, SLICERX_AGENT_BRIDGE: '1', CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || join(repo, 'target', 'agent-bridge') }
// On Windows pnpm is a .cmd script, which only a shell starts; the arguments are this script's own, without spaces.
const run = (args) => {
  const r = process.platform === 'win32' ? spawnSync(['pnpm', ...args].join(' '), { cwd: desktop, env, stdio: 'inherit', shell: true }) : spawnSync('pnpm', args, { cwd: desktop, env, stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

if (!values['no-geom']) {
  const core = join(repo, 'packages', 'geom', 'wasm', 'pkg', 'sx_geom_core.wasm')
  // as the edition CLI runs it (packages/edition-config/src/cli.ts); on Windows that needs Git's sh on the PATH
  const r = spawnSync('sh', ['packages/geom/wasm/scripts/build.sh'], { cwd: repo, env, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0 || !existsSync(core)) {
    console.error(`the geometry engine did not build (${r.error?.message ?? `exit ${r.status}`}); fix that, or pass --no-geom for a build without it`)
    process.exit(r.status || 1)
  }
}
run(['tauri:config'])
const conf = JSON.parse(readFileSync(join(desktop, 'src-tauri', 'gen', 'edition.conf.json'), 'utf8'))
const base = JSON.parse(readFileSync(join(desktop, 'src-tauri', 'tauri.conf.json'), 'utf8'))
// A bridge build's printer hub may listen on another loopback port (SX_TEST_HUB_PORT, src-tauri/src/link.rs), so the
// gate and the end-to-end tests can share a machine; its page may connect to any loopback port. A release keeps 47615.
const connectSrc = conf.app?.security?.csp?.['connect-src'] ?? base.app.security.csp['connect-src']
conf.app = { ...conf.app, security: { ...conf.app?.security, csp: { ...conf.app?.security?.csp, 'connect-src': `${connectSrc} ws://127.0.0.1:*` } } }
if (!values['same-identifier']) {
  conf.identifier = `${conf.identifier}.agent-bridge`
  // macOS keeps an unbundled binary's web data (localStorage, IndexedDB) under the executable's name, so every bridge
  // and dev binary called slicerx shared one store in ~/Library/WebKit/slicerx. The shell opens this build's window
  // itself, with a store of its own named from the identifier (agent_bridge/window.rs). A merge patch replaces arrays
  // whole, so the windows are written out in full.
  conf.app = { ...conf.app, windows: (conf.app?.windows ?? base.app.windows).map((w) => ({ ...w, create: false })) }
}
writeFileSync(join(desktop, 'src-tauri', 'gen', 'edition.bridge.conf.json'), `${JSON.stringify(conf, null, 2)}
`)
run(['tauri', 'build', '--config', 'src-tauri/gen/edition.bridge.conf.json', '--features', 'agent-bridge', '--no-bundle', ...(values.debug ? ['--debug'] : []), ...(values.target ? ['--target', values.target] : [])])
const bin = join(env.CARGO_TARGET_DIR, ...(values.target ? [values.target] : []), values.debug ? 'debug' : 'release', process.platform === 'win32' ? 'slicerx.exe' : 'slicerx')
console.log(`agent bridge build: ${bin} (identifier ${conf.identifier})`)
console.log('start it with SX_AGENT_BRIDGE_PORT=0 (and SX_AGENT_BRIDGE_TOKEN_FILE=<path> to choose where the token goes)')
