#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
//
// Runs the real-printer checklist (packages/connect/docs/real-printer-checklist.md) against one printer that
// a running hub (the desktop app or sx-link) already knows. Reading steps run on their own; every
// step that moves, heats or starts the printer asks the person at the printer first.
//
//   node packages/connect/link/deploy/scripts/real-printer-check.mjs --printer bay-1 \
//     [--file plate.gcode] [--url ws://127.0.0.1:47615] [--state-dir DIR] [--steps read,camera,print,control,adjust,watch] [--yes]
//
// The app code comes from SX_LINK_CODE or from `sx-link code` (the hub's state directory). Results
// go to real-printer-<printer>-<time>/ next to where it runs: report.json and the camera stills.
// Nothing secret is written there.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { connectLink } from '../../../link-client/src/index.ts'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? 'true' : (all[i + 1] ?? 'true')]] : acc), []),
)
if (!args.printer) {
  console.error('usage: real-printer-check.mjs --printer <id> [--file plate.gcode] [--url ws://127.0.0.1:47615] [--state-dir DIR] [--steps read,camera,print,control,adjust,watch]')
  process.exit(2)
}
const printerId = args.printer
const steps = new Set((args.steps ?? 'read,camera,print,control,adjust,watch').split(','))
const stateDir = args['state-dir'] ?? defaultStateDir()
const out = join(process.cwd(), `real-printer-${printerId}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
mkdirSync(out, { recursive: true })
const report = { printerId, startedAt: new Date().toISOString(), steps: [] }
const rl = createInterface({ input: process.stdin, output: process.stdout })

function defaultStateDir() {
  const home = process.env.HOME || homedir()
  if (platform() === 'darwin') return join(home, 'Library/Application Support/SlicerX/hub')
  if (platform() === 'win32') return join(process.env.APPDATA ?? home, 'SlicerX', 'hub')
  return join(process.env.XDG_STATE_HOME ?? join(home, '.local/state'), 'slicerx/hub')
}

function appCode() {
  if (process.env.SX_LINK_CODE) return process.env.SX_LINK_CODE
  try {
    return execFileSync('sx-link', ['code', '--state-dir', stateDir], { encoding: 'utf8' }).trim()
  } catch {
    try {
      return readFileSync(join(stateDir, 'pairing-code'), 'utf8').trim()
    } catch {
      throw new Error('No app code: set SX_LINK_CODE (the code the app or `sx-link code` shows).')
    }
  }
}

function hubKey() {
  try {
    return readFileSync(join(stateDir, 'hub-key.pub'), 'utf8').trim() || undefined
  } catch {
    return undefined
  }
}

/** Canonical JSON as the approval broker hashes it: keys sorted, no spaces. */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}
const hash = (v) => createHash('sha256').update(canonical(v)).digest('hex')

async function ask(question) {
  // --yes answers every question with yes, for a rerun where the person already stands at the printer.
  if (args.yes === 'true') {
    console.log(`${question} yes (--yes)`)
    return true
  }
  const a = (await rl.question(`${question} (y/N) `)).trim().toLowerCase()
  return a === 'y' || a === 'yes'
}

async function step(name, fn) {
  process.stdout.write(`\n== ${name}\n`)
  const started = Date.now()
  try {
    const detail = await fn()
    report.steps.push({ name, ok: detail !== 'skipped', skipped: detail === 'skipped', ms: Date.now() - started, detail: detail === 'skipped' ? undefined : detail })
    console.log(detail === 'skipped' ? '   skipped' : `   ok ${detail ? JSON.stringify(detail) : ''}`)
  } catch (e) {
    report.steps.push({ name, ok: false, ms: Date.now() - started, error: `${e.code ?? ''} ${e.message}`.trim() })
    console.log(`   FAILED ${e.code ?? ''} ${e.message}`)
  }
}

/** Registers a card for `actions` and grants it as the person running this script. */
let seq = 0
async function approve(host, title, actions, bedClear = false) {
  const id = `check-${Date.now()}-${seq++}`
  await host.approvals.register({
    id, sessionId: 'real-printer-check', tool: 'checklist', permission: 'start', title, lines: [], printerId,
    paramsHash: hash({}), actions: actions.map((a) => ({ action: a.action, target: printerId, paramsHash: hash(a.params) })),
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  })
  return host.approvals.grantWith(id, { bedClear })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitState(host, want, ms = 120_000) {
  const end = Date.now() + ms
  for (;;) {
    const s = await host.status(printerId)
    if (want.includes(s.state)) return s
    if (Date.now() > end) throw new Error(`printer stayed ${s.state}, wanted ${want.join(' or ')}`)
    await sleep(2000)
  }
}

const host = await connectLink({ url: args.url ?? 'ws://127.0.0.1:47615', code: appCode(), hubKey: hubKey() })
report.hubKey = host.hubKey ?? null

if (steps.has('read')) {
  await step('The printer is registered and reads its state', async () => {
    const info = (await host.list()).find((p) => p.id === printerId)
    if (!info) throw new Error(`no printer ${printerId} on this hub; add it in the app first`)
    const s = await host.status(printerId)
    report.info = { vendor: info.vendor, model: info.model, plugin: info.plugin }
    return { state: s.state, nozzles: s.nozzles, bed: s.bed, chamber: s.chamber, camera: s.cameraAvailable, watch: s.watch, slots: s.slots?.length }
  })
  await step('The bed record', async () => host.bed.state(printerId))
  await step('Mid-print limits read (only meaningful while printing)', async () => host.adjust.limits(printerId))
}

if (steps.has('camera')) {
  await step('One still from the camera (snapshot, or a decoded video frame)', async () => {
    const still = await host.camera.grab(printerId)
    if (!still) return 'skipped'
    const file = join(out, `still-${still.source}.${still.contentType.split('/')[1]}`)
    writeFileSync(file, still.data)
    return { contentType: still.contentType, bytes: still.data.length, source: still.source, file: basename(file), look: 'open the file and check it shows the bed' }
  })
  await step('Live camera probe', async () => host.camera.probe(printerId, 3000))
}

let printing = false
if (steps.has('print')) {
  await step('Upload and start a test plate from the Print sheet path (print.local)', async () => {
    if (!args.file) return 'skipped'
    const bytes = readFileSync(args.file)
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    const name = basename(args.file)
    const kind = name.endsWith('.gcode.3mf') ? 'gcode.3mf' : name.endsWith('.bgcode') ? 'bgcode' : 'gcode'
    const file = { name, kind, data, sha256: createHash('sha256').update(bytes).digest('hex') }
    const bed = await host.bed.state(printerId)
    let bedClear = false
    if (bed.askOnPrint) {
      bedClear = await ask(`The hub says the bed is ${bed.state}. Is the build plate clear and the right plate on?`)
      if (!bedClear) return 'skipped'
    }
    if (!(await ask(`Start ${name} on ${printerId} now? Someone should stay at the printer.`))) return 'skipped'
    const r = await host.printLocal(printerId, file, {}, bedClear)
    const s = await waitState(host, ['preparing', 'printing'])
    printing = true
    return { started: r.started, path: r.file.path, sha256: r.file.sha256, state: s.state }
  })
}

if (steps.has('control') && printing) {
  await step('Pause, then resume', async () => {
    if (!(await ask('Pause the print now, then resume it?'))) return 'skipped'
    const p = await approve(host, 'Pause (checklist)', [{ action: 'printer.pause', params: { printerId } }])
    await host.pause(printerId, p)
    await waitState(host, ['paused'])
    const r = await approve(host, 'Resume (checklist)', [{ action: 'printer.resume', params: { printerId } }])
    await host.resume(printerId, r)
    const s = await waitState(host, ['printing'])
    return { state: s.state }
  })
}

if (steps.has('adjust') && printing) {
  await step('Mid-print changes inside the limits (part fan 60 %, speed 100 %)', async () => {
    if (!(await ask('Set the part fan to 60 % and the speed factor to 100 %?'))) return 'skipped'
    const limits = await host.adjust.limits(printerId)
    const done = []
    for (const change of [{ kind: 'fan', fan: 'part', percent: 60 }, { kind: 'speed', percent: 100 }]) {
      const t = await approve(host, 'Change (checklist)', [{ action: 'printer.adjust', params: { printerId, change } }])
      await host.adjust.apply(printerId, change, t)
      done.push(change.kind)
    }
    return { limits, done, look: 'check the printer screen shows the fan and speed' }
  })
  await step('A change outside the limits is refused', async () => {
    const change = { kind: 'speed', percent: 400 }
    const t = await approve(host, 'Change (checklist)', [{ action: 'printer.adjust', params: { printerId, change } }])
    try {
      await host.adjust.apply(printerId, change, t)
    } catch (e) {
      if (e.code === 'out_of_range') return { refused: e.message }
      throw e
    }
    throw new Error('a 400 % speed factor was accepted')
  })
}

if (steps.has('watch') && printing) {
  await step('The print watch gets frames while printing', async () => {
    const frames = []
    const stop = await host.watch.subscribe((f) => frames.push(f), { everyMs: 2000, printerIds: [printerId] })
    const end = Date.now() + 30_000
    while (frames.length === 0 && Date.now() < end) await sleep(500)
    const s = await host.status(printerId)
    stop()
    if (!frames[0]) throw new Error('no frame in 30 s')
    writeFileSync(join(out, `watch-frame.${frames[0].contentType.split('/')[1]}`), frames[0].data)
    return { frames: frames.length, contentType: frames[0].contentType, watchWhileSubscribed: s.watch }
  })
}

if (printing) {
  await step('Cancel the test print and clear the plate', async () => {
    if (!(await ask('Cancel the test print now?'))) return 'skipped'
    const c = await approve(host, 'Cancel (checklist)', [{ action: 'printer.cancel', params: { printerId } }])
    await host.cancel(printerId, c)
    await waitState(host, ['idle', 'finished', 'error'], 60_000)
    await sleep(6000)
    const before = await host.bed.state(printerId)
    if (!(await ask('Remove the part and confirm the plate is clear?'))) return { bedAfterCancel: before.state }
    const after = await host.bed.confirmClear(printerId)
    return { bedAfterCancel: before.state, bedAfterConfirm: after.state }
  })
}

report.finishedAt = new Date().toISOString()
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
const failed = report.steps.filter((s) => !s.ok && !s.skipped)
console.log(`\nReport: ${join(out, 'report.json')}  (${report.steps.length - failed.length} ok or skipped, ${failed.length} failed)`)
rl.close()
host.close()
process.exit(failed.length ? 1 : 0)
