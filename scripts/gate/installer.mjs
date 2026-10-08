#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// The gate's short check of a real signed release (no bridge in it), Windows only: optionally installs it (per user,
// silent), checks the program's signature, starts it with the WebView2 debugging port and a fresh web profile, gets
// through first run, checks that the Vault's pictures load with no content security refusal, and, with --account,
// that a sign-in link comes back to the app (an operator opens the link; the installed app's slicerx:// handler takes
// it). It stops the app by its process id. On macOS and Linux this check is a manual step (docs/release-gate.md).
//   node scripts/gate/installer.mjs [--installer <setup.exe>] [--exe <slicerx.exe>] --out <dir> [--account <qa address>]
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { release, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { renderReport, runStatus } from './lib/report.mjs'
import { mask, QA_ACCOUNT, sha256File, sleep, waitUntil } from './lib/util.mjs'

const { values } = parseArgs({
  options: { installer: { type: 'string' }, exe: { type: 'string' }, out: { type: 'string' }, account: { type: 'string' }, port: { type: 'string' }, 'wait-signin': { type: 'string' }, commit: { type: 'string' } },
  strict: true,
})
const log = (line) => process.stdout.write(`${mask(line)}\n`)
if (process.platform !== 'win32') {
  log('The signed installer check runs on Windows only. On macOS and Linux it is a manual step: docs/release-gate.md, "The signed installer".')
  process.exit(2)
}
const account = values.account?.trim().toLowerCase() ?? null
if (account && !QA_ACCOUNT.test(account)) {
  log(`${account} is not a release-gate account (@qa.slicerx.app)`)
  process.exit(2)
}
const out = resolve(values.out ?? join(tmpdir(), `sx-gate-installer-${Date.now()}`))
const shots = join(out, 'shots')
mkdirSync(shots, { recursive: true })
const port = Number(values.port ?? 9333)
const exe = resolve(values.exe ?? join(process.env.LOCALAPPDATA ?? '', 'SlicerX', 'slicerx.exe'))
const ps = (cmd) => spawnSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).stdout.trim()
const q = (p) => `'${p.replace(/'/g, "''")}'`

const rec = { id: 'i', title: 'Signed installer: installs, launches, Vault pictures, sign-in returns', platform: 'windows (signed)', startedAt: new Date().toISOString(), steps: [], shots: [], console: [], network: [], toasts: [] }
const step = (name, ok, detail) => {
  const d = detail === undefined ? undefined : mask(typeof detail === 'string' ? detail : JSON.stringify(detail))
  rec.steps.push({ name, ok, ...(d ? { detail: d } : {}) })
  log(`${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'info'} ${name}${d ? `: ${d.slice(0, 400)}` : ''}`)
}
const result = { tool: 'slicerx-release-gate', format: 1, platform: 'windows (signed)', host: `win32 ${release()}, node ${process.version}`, account, commit: values.commit ?? null, build: { file: basename(exe), kind: 'signed release' }, startedAt: rec.startedAt, scenarios: [rec], notes: [] }

/** A minimal Chrome DevTools Protocol client over Node's own WebSocket. */
async function cdp(wsUrl, onEvent) {
  const ws = new WebSocket(wsUrl)
  await new Promise((r, j) => {
    ws.onopen = r
    ws.onerror = () => j(new Error('the debugging port refused the connection'))
  })
  let next = 0
  const waiting = new Map()
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data))
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg)
      waiting.delete(msg.id)
    } else if (msg.method) onEvent(msg)
  }
  const send = (method, params = {}) =>
    new Promise((r, j) => {
      const id = ++next
      waiting.set(id, (msg) => (msg.error ? j(new Error(msg.error.message)) : r(msg.result)))
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  return { send, evaluate, close: () => ws.close() }
}

const $ = (id) => `document.querySelector('[data-testid="${id}"]')`
const visible = (id) => `(() => { const e = ${$(id)}; if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 })()`

let child = null
let page = null
const work = mkdtempSync(join(tmpdir(), 'sx-gate-signed-'))
try {
  if (values.installer) {
    const setup = resolve(values.installer)
    result.build.installer = basename(setup)
    result.build.installerSha256 = await sha256File(setup)
    const sig = ps(`(Get-AuthenticodeSignature ${q(setup)}).Status`)
    step('the installer is signed', sig === 'Valid', `${sig}: ${ps(`(Get-AuthenticodeSignature ${q(setup)}).SignerCertificate.Subject`)}`)
    log('installing per user, silent (no elevation expected)')
    const r = spawnSync(setup, ['/S'], { timeout: 600_000 })
    step('the installer runs (per user, silent)', r.status === 0 && existsSync(exe), `exit ${r.status}`)
  }
  if (!existsSync(exe)) throw new Error(`no app at ${exe}`)
  result.build.sha256 = await sha256File(exe)
  result.build.version = ps(`(Get-Item ${q(exe)}).VersionInfo.ProductVersion`)
  const sig = ps(`(Get-AuthenticodeSignature ${q(exe)}).Status`)
  step(`the program is signed (${result.build.version})`, sig === 'Valid', `${sig}: ${ps(`(Get-AuthenticodeSignature ${q(exe)}).SignerCertificate.Subject`)}`)
  if (Number(ps(`@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq ${q(exe)} }).Count`)) > 0) throw new Error(`${exe} is already running; quit it first (single instance)`)

  const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: join(work, 'webview2') }
  child = spawn(exe, [], { env, stdio: 'ignore' })
  log(`started ${exe} as pid ${child.pid}`)
  const target = await waitUntil(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      return list.find((t) => t.type === 'page' && !t.url.startsWith('devtools')) ?? null
    } catch {
      return null
    }
  }, { timeoutMs: 60_000, everyMs: 500 })
  if (target.timedOut) throw new Error('no page on the debugging port after 60 s')
  step('the app launches', true, { pid: child.pid })
  const csp = []
  const probes = []
  const errors = []
  page = await cdp(target.value.webSocketDebuggerUrl, (msg) => {
    if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry
      // A refused eval is a library probing whether eval is allowed (zod at startup); it is reported, not failed.
      if (/evaluate a string as JavaScript/.test(e.text)) probes.push(e.text)
      else if (e.source === 'security' || /Content Security Policy|Refused to/.test(e.text)) csp.push(e.text)
      else if (e.level === 'error') errors.push(`${e.text} ${e.url ?? ''}`)
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
  })
  await page.send('Log.enable')
  await page.send('Runtime.enable')
  await page.send('Page.enable')
  // The page records refusals itself too, for the ones before the protocol connected.
  await page.evaluate(`document.addEventListener('securitypolicyviolation', (e) => { if (e.blockedURI !== 'eval') window.__gateCsp = (window.__gateCsp || 0) + 1 }); true`)
  const shot = async (name, caption) => {
    const r = await page.send('Page.captureScreenshot', { format: 'png' })
    const file = `i-${String(rec.shots.length + 1).padStart(2, '0')}-${name}.png`
    writeFileSync(join(shots, file), Buffer.from(r.data, 'base64'))
    rec.shots.push({ file: `shots/${file}`, caption })
  }
  const click = (id) => page.evaluate(`(() => { const e = ${$(id)}; if (!e) return false; e.click(); return true })()`)

  // First run: the agreement, then Skip, use defaults.
  for (let i = 0; i < 60; i++) {
    if (await page.evaluate(visible('agreement-check'))) {
      await click('agreement-check')
      await sleep(300)
      await click('agreement-accept')
    } else if (await page.evaluate(visible('update-later'))) await click('update-later')
    else if (await page.evaluate(visible('setup-skip-all'))) await click('setup-skip-all')
    else if (await page.evaluate(visible('tab-feed'))) break
    await sleep(700)
  }
  step('first run gets to the app', await page.evaluate(visible('tab-feed')))

  // The Vault's pictures.
  await click('tab-feed')
  const cards = await waitUntil(async () => ((await page.evaluate(visible('vault-card'))) ? true : null), { timeoutMs: 30_000, everyMs: 500 })
  step('the Vault shows design cards', !cards.timedOut)
  await sleep(6000)
  const imgs = await page.evaluate(`[...document.querySelectorAll('img')].map((i) => { const r = i.getBoundingClientRect(); return { url: (i.currentSrc || i.src).split(/[?#]/)[0], state: !i.complete ? 'pending' : i.naturalWidth > 0 ? 'loaded' : 'failed', inView: r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.left < innerWidth } })`)
  const bad = imgs.filter((i) => i.state === 'failed' || (i.inView && i.state !== 'loaded'))
  step(`Vault pictures load: ${imgs.filter((i) => i.state === 'loaded').length} of ${imgs.length}`, imgs.length > 0 && bad.length === 0, bad.map((i) => `${i.state} ${i.url}`).slice(0, 10))
  const pageCsp = await page.evaluate('window.__gateCsp || 0')
  step('no content security refusals', csp.length === 0 && pageCsp === 0, csp.slice(0, 5))
  if (probes.length) step(`eval refused ${probes.length} time(s): a script checking whether eval is allowed; nothing was blocked from loading`, null)
  await shot('vault', 'Signed release: the Vault')
  rec.console = [...csp, ...errors].slice(-40).map(mask)

  // Sign-in comes back to the app.
  if (account) {
    const minutes = Number(values['wait-signin'] ?? 10)
    await click('vault-sign-in')
    await waitUntil(async () => ((await page.evaluate(visible('signin-email'))) ? true : null), { timeoutMs: 15_000, everyMs: 300 })
    await page.evaluate(`(() => { const e = ${$('signin-email')}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, ${JSON.stringify(account)}); e.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await click('signin-submit')
    const at = new Date().toISOString()
    const sent = await waitUntil(async () => ((await page.evaluate(visible('signin-sent'))) ? true : null), { timeoutMs: 30_000, everyMs: 500 })
    step(`asked for a sign-in link for ${account} at ${at}`, !sent.timedOut)
    log(`\nOPERATOR: open the newest sign-in link sent to ${account} after ${at} on this computer. This is the installed app, so its slicerx:// handler takes the link's redirect. Waiting ${minutes} min.\n`)
    const back = await waitUntil(async () => ((await page.evaluate(visible('account-menu'))) ? true : null), { timeoutMs: minutes * 60_000, everyMs: 3000 })
    step('the sign-in link comes back to the app (signed in)', !back.timedOut, back.timedOut ? 'no sign-in: the operator step was not done' : undefined)
    await shot('signed-in', back.timedOut ? 'Signed release: still signed out' : 'Signed release: signed in through the link')
  } else step('sign-in comes back to the app', null, 'not checked: no --account')
} catch (e) {
  step('the check stopped', false, e instanceof Error ? e.message : String(e))
} finally {
  page?.close()
  if (child && child.exitCode === null) {
    // By its own process id: ask the window to close, then end it if it stays.
    const closed = ps(`$p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if (-not $p) { 'closed' } else { [void]$p.CloseMainWindow(); if ($p.WaitForExit(10000)) { 'closed' } else { 'open' } }`)
    if (closed !== 'closed') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    log(`stopped the app, pid ${child.pid}`)
  }
  await sleep(1000)
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  rec.endedAt = result.endedAt = new Date().toISOString()
  rec.status = rec.steps.some((s) => s.ok === false) ? 'FAIL' : 'PASS'
  result.status = runStatus(result)
  writeFileSync(join(out, 'results.json'), `${JSON.stringify(result, null, 2)}\n`)
  writeFileSync(join(out, 'report.html'), renderReport([result]))
  log(`signed installer check: ${result.status}. Report: ${join(out, 'report.html')}`)
  process.exitCode = result.status === 'FAIL' ? 1 : 0
}
