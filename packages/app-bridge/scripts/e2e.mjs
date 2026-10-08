// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// End to end through the running-app MCP server: starts a bridge build of the desktop app with a fresh web profile,
// connects this package's server to it over stdio, calls every read tool and the safe acts (first run, open a file,
// slice, export, clear the plate), checks the refusals, saves screenshots and a report, and stops the app by its pid.
// Nothing signs in and nothing is written to a backend: build the app without SLICERX_SUPABASE_URL (demo Vault).
//   node packages/app-bridge/scripts/e2e.mjs [--app <binary>] [--file <model>] [--out <dir>]
// Build the app first: pnpm --filter @slicerx/desktop build:bridge
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const repo = resolve(import.meta.dirname, '../../..')
const win = process.platform === 'win32'
const { values } = parseArgs({ options: { app: { type: 'string' }, file: { type: 'string' }, out: { type: 'string' } }, strict: true })
const app = resolve(values.app ?? join(repo, 'target', 'agent-bridge', 'release', win ? 'slicerx.exe' : 'slicerx'))
const file = resolve(values.file ?? join(repo, 'packages', 'core', 'bench', 'models', 'x-mark.stl'))
const out = resolve(values.out ?? join(tmpdir(), `sx-bridge-e2e-${Date.now()}`))
mkdirSync(out, { recursive: true })
const tokenFile = join(out, 'agent-bridge.json')

const steps = []
let failed = 0
const log = (line) => process.stdout.write(`${line}\n`)
function record(name, ok, detail) {
  steps.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
  if (!ok) failed++
  log(`${ok ? 'pass' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}`}`)
}

if (!existsSync(app)) {
  log(`no app at ${app}; build it with pnpm --filter @slicerx/desktop build:bridge`)
  process.exit(2)
}
// The app is single-instance per identifier: a running copy of this build would take our launch over, and the test
// would drive the wrong app. (An installed SlicerX has its own identifier and does not count.)
if (win) {
  const t = spawnSync('powershell', ['-NoProfile', '-Command', `@(Get-Process slicerx -ErrorAction SilentlyContinue | Where-Object Path -eq '${app.replace(/'/g, "''")}').Count`], { encoding: 'utf8' })
  if (Number(t.stdout.trim()) > 0) {
    log(`${app} is already running; quit it first (the app is single-instance)`)
    process.exit(2)
  }
}

const env = { ...process.env, SX_AGENT_BRIDGE_PORT: '0', SX_AGENT_BRIDGE_TOKEN_FILE: tokenFile }
// A fresh web profile, so first run shows and nothing of the person's own app state is read or changed.
if (win) env.WEBVIEW2_USER_DATA_FOLDER = join(out, 'webview2')
rmSync(tokenFile, { force: true })
const child = spawn(app, [], { env, stdio: ['ignore', 'ignore', 'pipe'], detached: false })
let stderr = ''
child.stderr.on('data', (d) => (stderr += d))
log(`started ${app} as pid ${child.pid}; output in ${out}`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let client = null
try {
  for (let i = 0; i < 120 && !existsSync(tokenFile); i++) await sleep(500)
  record('connection file written', existsSync(tokenFile), tokenFile)
  if (!existsSync(tokenFile)) throw new Error(`no connection file; app stderr: ${stderr.slice(-400)}`)

  // The endpoint refuses a request without the token, before any tool runs.
  const { port } = JSON.parse(readFileSync(tokenFile, 'utf8'))
  const status = await new Promise((r) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/call', headers: { 'content-type': 'application/json' } }, (res) => {
      res.resume()
      r(res.statusCode)
    })
    req.on('error', () => r(0))
    req.end('{"tool":"state"}')
  })
  record('no token is refused (401)', status === 401, status)

  client = new Client({ name: 'bridge-e2e', version: '0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(repo, 'packages', 'app-bridge', 'src', 'cli.ts'), '--token-file', tokenFile], stderr: 'ignore' }))
  const { tools } = await client.listTools()
  record('tools listed', tools.length === 20, tools.map((t) => t.name))

  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args })
    return { error: r.isError ? r.content?.[0]?.text : null, data: r.structuredContent, content: r.content }
  }
  const expectOk = async (name, args = {}, check = () => true) => {
    const r = await call(name, args)
    const ok = !r.error && check(r.data)
    record(`${name}${Object.keys(args).length ? ` ${JSON.stringify(args).slice(0, 80)}` : ''}`, ok, r.error ?? summarize(name, r.data))
    return r
  }
  /** Fails the run with a clear line when a control it needs has no test id on the page (renamed, or not in this build). */
  const needIds = async (...ids) => {
    const on = (await call('app_testids', { all: true })).data ?? {}
    const missing = ids.filter((id) => !on[id])
    record(`test ids ${ids.join(', ')} on the page`, missing.length === 0, missing.length ? `missing ${missing.join(', ')}; see docs/test-ids.md for the current ids` : undefined)
    if (missing.length) throw new Error(`the app has no control with the test id ${missing.join(', ')}`)
  }
  const summarize = (name, d) => {
    if (!d) return undefined
    if (name === 'app_state') return { tab: d.tab, objects: d.plate?.objects?.map((o) => o.name), slicing: d.slicing?.status, dialogs: d.dialogs?.map((x) => x.title) }
    if (name === 'app_slice') return { status: d.status, layers: d.layers, timeS: d.timeS, filamentG: d.filamentG, warnings: d.warnings?.length }
    if ('entries' in d) return { marker: d.marker, entries: d.entries.length, last: d.entries.at(-1) }
    return d
  }

  // The page side comes up first, then the app (appReady), then its first frame.
  let health = null
  for (let i = 0; i < 120; i++) {
    const r = await call('app_health')
    if (!r.error && r.data?.appReady) {
      health = r.data
      break
    }
    await sleep(500)
  }
  record('app_health (app ready)', Boolean(health), health ?? undefined)
  if (!health) throw new Error('the app did not come up')
  let rendered = false
  for (let i = 0; i < 60 && !rendered; i++) {
    const r = await call('app_testids')
    rendered = !r.error && Object.keys(r.data ?? {}).length > 0
    if (!rendered) await sleep(500)
  }
  record('first frame has test ids', rendered)

  // First run on the fresh profile: the agreement, then Skip, use defaults, until the objects list shows.
  let prepared = false
  let ids = {}
  for (let i = 0; i < 60 && !prepared; i++) {
    ids = (await call('app_testids')).data ?? {}
    if (ids['agreement-check']) {
      await expectOk('app_click', { testid: 'agreement-check' })
      await expectOk('app_click', { testid: 'agreement-accept' })
    } else if (ids['setup-skip-all']) {
      await expectOk('app_click', { testid: 'setup-skip-all' })
    } else prepared = Boolean(ids['objects-list'])
    if (!prepared) await sleep(500)
  }
  record('first run done, objects list on screen', prepared, prepared ? undefined : { onScreen: Object.keys(ids), tab: (await call('app_state')).data?.tab })
  if (!prepared) await call('app_screenshot', { path: join(out, '00-not-prepared.png') })

  // The controls this run uses by test id, so a renamed one fails here, by name, and not as a vague step further on.
  await needIds('tab-prepare', 'objects-list')

  // Every read.
  await expectOk('app_state', {}, (d) => typeof d.tab === 'string' && Array.isArray(d.plate?.objects))
  await expectOk('app_testids', {}, (d) => Object.keys(d).some((k) => k.startsWith('tab-')))
  await expectOk('app_element', { testid: 'tab-prepare' }, (d) => d.matches?.length === 1)
  await expectOk('app_toasts')
  await expectOk('app_dialogs', {}, (d) => Array.isArray(d.open))
  await expectOk('app_console', {}, (d) => Array.isArray(d.entries))
  await expectOk('app_network', {}, (d) => Array.isArray(d.entries))
  await expectOk('app_user', {}, (d) => typeof d.signedIn === 'boolean')
  const shot = await expectOk('app_screenshot', { path: join(out, '01-start.png') }, (d) => d.width > 100 && d.height > 100)
  record('screenshot is an image', shot.content?.[0]?.type === 'image' && shot.content[0].mimeType === 'image/png')

  // Safe acts: the Prepare tab, a clear plate, a file by path, a slice, the export.
  await expectOk('app_click', { testid: 'tab-prepare' })
  await expectOk('app_wait_for', { testid: 'objects-list', state: 'present', timeoutMs: 15000 })
  const marker = (await call('app_state')).data?.marker ?? 0
  await expectOk('app_clear_plate', {}, (d) => d.cleared === true)
  await expectOk('app_open_file', { path: file, timeoutMs: 120000 }, (d) => (d.state?.plate?.objects?.length ?? 0) > 0)
  await expectOk('app_element', { testid: 'object-row' }, (d) => d.matches?.length > 0)
  await expectOk('app_screenshot', { path: join(out, '02-opened.png') })
  const sliced = await expectOk('app_slice', { timeoutMs: 600000 }, (d) => d.status === 'done' && d.layers > 0)
  await expectOk('app_export_gcode', {}, (d) => d.bytes > 0 && existsSync(d.path))
  await expectOk('app_screenshot', { path: join(out, '03-sliced.png') })
  await expectOk('app_toasts', { since: marker })
  await expectOk('app_press_key', { key: 'Escape' })

  // Refusals: a link that is not a sign-in callback, a missing control, a relative path.
  const notLink = await call('app_auth_callback', { url: 'https://example.com/auth/callback?code=x' })
  record('app_auth_callback refuses other links', /refused/.test(notLink.error ?? ''), notLink.error)
  const missing = await call('app_click', { testid: 'no-such-control' })
  record('app_click on a missing id fails', /not_found/.test(missing.error ?? ''), missing.error)
  const rel = await call('app_open_file', { path: 'relative.stl' })
  record('app_open_file refuses a relative path', /invalid_input/.test(rel.error ?? ''), rel.error)

  // Clear the plate again; an opened file can leave unsaved changes, which the app asks about.
  const cleared = await call('app_clear_plate')
  if (cleared.data?.asking) {
    record('app_clear_plate asks before discarding', true, cleared.data.asking)
    await expectOk('app_click', { testid: 'unsaved-discard' })
    await sleep(500)
  } else record('app_clear_plate', !cleared.error && cleared.data?.cleared === true, cleared.error ?? undefined)
  await expectOk('app_state', {}, (d) => d.plate.objects.length === 0)
  if (sliced.data) writeFileSync(join(out, 'slice.json'), JSON.stringify(sliced.data, null, 2))

  // The Vault on this build's data (demo data without a backend): its tab, Feed, a card, and opening that design
  // through its sheet. Reported, not counted: what the demo store can download depends on the build.
  await expectOk('app_click', { testid: 'tab-feed' })
  const card = await call('app_wait_for', { testid: 'vault-card', state: 'visible', timeoutMs: 20000 })
  if (!card.error) {
    const first = (await call('app_element', { testid: 'vault-card' })).data?.matches?.[0]
    const opened = first?.data?.listing ? await call('app_open_vault_design', { id: first.data.listing, timeoutMs: 60000 }) : { error: 'no listing id on the card' }
    log(`info app_open_vault_design ${first?.data?.listing ?? ''}: ${opened.error ?? JSON.stringify(opened.data?.listing)}`)
    steps.push({ name: 'app_open_vault_design (info)', ok: true, detail: opened.error ?? opened.data?.listing })
    await expectOk('app_screenshot', { path: join(out, '04-vault.png') })
  } else log(`info no Vault cards: ${card.error}`)
} catch (e) {
  record('run', false, e instanceof Error ? e.message : String(e))
} finally {
  await client?.close().catch(() => undefined)
  // Stopped by its own pid, never by name. On macOS and Linux SIGTERM, which the app catches to remove its connection
  // file. On Windows a forced stop cannot be caught, so the window is asked to close first (the normal quit, which
  // removes the file), and only an app still running after that is forced. That first taskkill names the app alone:
  // with /T it would ask the web view's processes first, which only a forced stop ends, and give up on the app.
  const ended = async (ms) => {
    for (let t = 0; t < ms && child.exitCode === null && child.signalCode === null; t += 250) await sleep(250)
    return child.exitCode !== null || child.signalCode !== null
  }
  let forced = false
  if (child.exitCode === null) {
    if (win) {
      spawnSync('taskkill', ['/PID', String(child.pid)])
      if (!(await ended(10_000))) {
        forced = true
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'])
      }
    } else child.kill('SIGTERM')
  }
  record('app stopped by pid', await ended(10_000), { pid: child.pid, ...(forced ? { forced } : {}) })
  if (forced) {
    log('info the app did not close on request and was forced; its connection file is removed here')
    rmSync(tokenFile, { force: true })
  } else record('the app removed its connection file when it stopped', !existsSync(tokenFile), tokenFile)
  writeFileSync(join(out, 'report.json'), JSON.stringify({ app, file, steps, stderr: stderr.slice(-4000) }, null, 2))
  log(`${steps.length - failed} of ${steps.length} passed; report ${join(out, 'report.json')}`)
  process.exit(failed ? 1 : 0)
}
