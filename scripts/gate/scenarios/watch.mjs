// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// w. The watch pause turns the heaters off. A fake Klipper printer (packages/connect/mock-printers) prints; the gate
// tells the app's own printer hub, as a failure detector, that it saw spaghetti, and the hub pauses the print. Nobody
// answers the pause, so the hub turns the bed off, then the nozzle. The status read the hub had already started when the
// pause landed still says printing (the race #574 fixed); the steps must follow anyway. No real printer is ever
// contacted: the fake listens on this computer's loopback address only.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { repo } from '../lib/app.mjs'
import { sleep, waitUntil } from '../lib/util.mjs'

/**
 * The hub's watch timings in a bridge build started for w: a reading every 2 s, the bed off 12 s and the nozzle 20 s
 * after an unanswered pause (30 minutes and 2 hours in a release). The app reads them from SX_GATE_WATCH_PAUSE, which
 * only a bridge build knows (apps/desktop/src-tauri/src/link.rs).
 */
export const WATCH_TIMINGS = { everyMs: 2000, bedMs: 12_000, heatersMs: 20_000 }

/** SX_GATE_WATCH_PAUSE for `timings`. */
export const watchPauseEnv = (t = WATCH_TIMINGS) => `${t.everyMs},${t.bedMs},${t.heatersMs}`

/**
 * When to hold the fake's status reads and when to report, so the pause lands while one of the hub's own readings is
 * on its way: every read that starts in the next `windowMs` (one hub tick and a little) answers `holdMs` later with the
 * state it started with, and the report goes `fireAfterMs` after arming, when the tick's read has started and is still
 * held. The held read must answer within the hub's 10 s status limit, and the bed step must come after the hold and
 * two more ticks, or a fixed hub would rightly forget a pause that never showed.
 */
export function racePlan(t = WATCH_TIMINGS) {
  const plan = { holdMs: t.everyMs + 2000, windowMs: t.everyMs + 500, fireAfterMs: t.everyMs + 200 }
  if (plan.holdMs >= 10_000) throw new Error('the held read must answer within the hub\'s 10 s status limit')
  if (t.bedMs < plan.holdMs + 2 * t.everyMs) throw new Error('the bed step must come after the held read and two more readings')
  return plan
}

/**
 * The bridge build's printer hub folder: `<app data>/<identifier>/hub`, where the hub keeps its codes and key. The app
 * data folder is %APPDATA% on Windows, the run's XDG_DATA_HOME on Linux, and Application Support on macOS.
 */
export function hubDir({ platform, env = process.env, identifier = 'app.slicerx.desktop.agent-bridge', home = homedir() }) {
  const base = platform === 'windows' ? env.APPDATA : platform === 'linux' ? env.XDG_DATA_HOME ?? join(home, '.local', 'share') : join(home, 'Library', 'Application Support')
  if (!base) throw new Error('no app data folder (APPDATA is not set)')
  return join(base, identifier, 'hub')
}

/**
 * Whether the fake's request log shows the watch pause's steps in order after the pause: `pause`, then the bed off
 * (`gcode M140 S0`), then the nozzle off (`gcode M104 S0`), and no other G-code. `held` says whether a held status read
 * had started before the pause (the race).
 */
export function heaterSteps(log) {
  const pause = log.indexOf('pause')
  if (pause < 0) return { ok: false, paused: false, held: false, gcode: [], why: 'the printer was never asked to pause' }
  const held = log.slice(0, pause).includes('status read held')
  const gcode = log.slice(pause + 1).filter((l) => l.startsWith('gcode '))
  const want = ['gcode M140 S0', 'gcode M104 S0']
  const ok = gcode.length === 2 && gcode[0] === want[0] && gcode[1] === want[1]
  const why = ok ? '' : gcode.length === 0 ? 'no heater was turned off' : gcode[0] !== want[0] ? `the first step was ${gcode[0]}, not the bed` : gcode.length < 2 ? 'the bed went off but the nozzle never did' : `unexpected G-code: ${gcode.join(', ')}`
  return { ok, paused: true, held, gcode, why }
}

/** Starts the fake Klipper printer on loopback; resolves to its ports and a stop that ends it by its process id. */
async function startFake() {
  const cli = join(repo, 'packages', 'connect', 'mock-printers', 'src', 'cli.ts')
  const child = spawn(process.execPath, [cli, '--only', 'moonraker'], { stdio: ['pipe', 'pipe', 'ignore'] })
  const line = await new Promise((resolve, reject) => {
    const rl = createInterface({ input: child.stdout })
    const timer = setTimeout(() => reject(new Error('the fake printer did not start in 30 s')), 30_000)
    rl.once('line', (l) => {
      clearTimeout(timer)
      resolve(l)
    })
    child.once('exit', (code) => reject(new Error(`the fake printer exited (${code})`)))
  })
  const info = JSON.parse(line)
  const stop = async () => {
    if (child.exitCode !== null) return
    child.stdin.end()
    for (let i = 0; i < 20 && child.exitCode === null; i++) await sleep(250)
    // Stopped by its own process id, never by name.
    if (child.exitCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      else child.kill('SIGKILL')
    }
  }
  const control = async (path, body) => {
    const r = await fetch(`http://127.0.0.1:${info.control}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
    if (!r.ok) throw new Error(`fake printer ${path}: HTTP ${r.status}`)
    return r.json()
  }
  return { port: info.ports.moonraker, pid: child.pid, stop, control, log: async () => (await control('/state')).moonraker?.log ?? [], state: async () => (await control('/state')).moonraker?.state }
}

/** The printer hub's client (packages/connect/link-client), as the app and sx-watch use it. */
async function linkClient() {
  return import(pathToFileURL(join(repo, 'packages', 'connect', 'link-client', 'src', 'index.ts')).href)
}

const PRINTER = 'gate-watch'

/** `url` is the app's hub (the port the gate gave it in SX_TEST_HUB_PORT); without it, sx-link's default port. */
export async function watchPause(s, { hub, url, timings = WATCH_TIMINGS }) {
  const plan = racePlan(timings)
  s.info('the hub\'s watch timings for this run', { ...timings, hold: plan })
  const read = (name) => readFileSync(join(hub, name), 'utf8').trim()
  const files = await waitUntil(async () => (['pairing-code', 'watch-code', 'hub-key.pub'].every((f) => existsSync(join(hub, f))) ? true : null), { timeoutMs: 30_000, everyMs: 500 })
  if (files.timedOut) return s.stop('the app\'s printer hub is running', `no codes in ${hub}`)
  const fake = await startFake()
  s.info('the fake Klipper printer (loopback only)', { port: fake.port, pid: fake.pid })
  const { connectLink } = await linkClient()
  let app = null
  let watch = null
  try {
    const hubKey = read('hub-key.pub')
    const at = url ? { url } : {}
    app = await connectLink({ ...at, code: read('pairing-code'), hubKey })
    watch = await connectLink({ ...at, code: read('watch-code'), hubKey, role: 'watch' })
    s.check('paired with the app\'s hub as an app and as a failure detector', app && watch)
    await app.removePrinter(PRINTER).catch(() => undefined)
    await app.addPrinter({ id: PRINTER, name: 'Gate watch (fake)', plugin: 'moonraker', host: '127.0.0.1', port: fake.port })
    await app.watch.setAutoPause(PRINTER, true)
    s.check('the fake printer is added with the watch allowed to pause it', true)

    await fake.control('/set', { mock: 'moonraker', state: 'printing' })
    const printing = await waitUntil(async () => ((await app.status(PRINTER)).state === 'printing' ? true : null), { timeoutMs: 20_000, everyMs: 500 })
    s.check('the hub sees the print', !printing.timedOut)
    // The hub's own watcher must have read it printing too before a finding may pause it.
    await sleep(2 * timings.everyMs + 500)

    await fake.control('/slow', { mock: 'moonraker', statusHoldMs: plan.holdMs, statusWindowMs: plan.windowMs })
    await sleep(plan.fireAfterMs)
    const reported = await watch.watch.report({ printerId: PRINTER, kind: 'spaghetti', confidence: 0.92, confirmed: true, note: 'release gate w' })
    const pausedAt = Date.now()
    s.check('a confirmed spaghetti finding pauses the print', reported.paused, reported)
    const paused = await waitUntil(async () => ((await fake.state()) === 'paused' ? true : null), { timeoutMs: 5000, everyMs: 200 })
    s.check('the printer reports paused', !paused.timedOut)

    // The steps, timed as they reach the printer.
    let bedAt = null
    let nozzleAt = null
    const done = await waitUntil(
      async () => {
        const log = await fake.log()
        if (bedAt === null && log.includes('gcode M140 S0')) bedAt = Date.now() - pausedAt
        if (nozzleAt === null && log.includes('gcode M104 S0')) nozzleAt = Date.now() - pausedAt
        return nozzleAt !== null ? log : null
      },
      { timeoutMs: timings.heatersMs + 4 * timings.everyMs + 10_000, everyMs: 250 },
    )
    const steps = heaterSteps(done.value ?? (await fake.log()))
    s.check('a status read started before the pause and answered after it (the race)', steps.held, steps.held ? 'held read in flight at the pause' : 'no held read before the pause; the race was not set up')
    s.check('the bed goes off, then the nozzle, and nothing else is sent', steps.ok, steps.ok ? steps.gcode : steps.why)
    s.check(`the bed goes off after its ${timings.bedMs / 1000} s and the nozzle after its ${timings.heatersMs / 1000} s`, bedAt !== null && nozzleAt !== null && bedAt >= timings.bedMs - 500 && nozzleAt >= timings.heatersMs - 500 && bedAt < nozzleAt, { bedOffAfterMs: bedAt, nozzleOffAfterMs: nozzleAt })
    const st = await app.status(PRINTER)
    s.info('the hub\'s status of the printer after the steps', { state: st.state, pauseNote: st.pauseNote ?? null })
  } finally {
    if (app) {
      await app.watch.setAutoPause(PRINTER, false).catch(() => undefined)
      await app.removePrinter(PRINTER).catch(() => undefined)
      app.close()
    }
    watch?.close()
    await fake.stop()
  }
}
