// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// A small print farm tool: slices every model in a folder with the sx command line tool, writes
// G-code and a preview per model, and can queue the results on a printer through the hub.
//
//   node src/farm.ts <models> [--out <dir>] [--config <config.json>] [--bed 256x256x250]
//        [--flavor klipper] [--sx <path to sx>] [--watch]
//        [--queue <printer id> [--hub ws://127.0.0.1:47615] [--hub-key <base64>]]
//
// The hub's app code is read from SX_LINK_CODE so it stays out of the shell history.
import { watch } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { askTerminal, queuePlates, type QueueTarget, type Sliced } from './queue.ts'
import { isStale, listJobs, type Job } from './scan.ts'
import { describe, sliceModel, type Bed, type SliceSettings } from './slice.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: 'farm-out' },
    config: { type: 'string' },
    bed: { type: 'string', default: '256x256x250' },
    flavor: { type: 'string' },
    sx: { type: 'string', default: process.env['SX_BIN'] ?? 'sx' },
    watch: { type: 'boolean', default: false },
    queue: { type: 'string' },
    hub: { type: 'string', default: 'ws://127.0.0.1:47615' },
    'hub-key': { type: 'string' },
  },
})

const inDir = positionals[0]
if (!inDir) {
  console.error('usage: node src/farm.ts <models folder> [--out <dir>] [--config <json>] [--watch] [--queue <printer id>]')
  process.exit(2)
}

function parseBed(text: string): Bed {
  const [w, d, h] = text.split('x').map(Number)
  if (!w || !d || !h) throw new Error(`--bed takes width x depth x height in mm, for example 256x256x250, not ${text}`)
  return { widthMm: w, depthMm: d, heightMm: h }
}

const settings: SliceSettings = {
  config: values.config ? (JSON.parse(await readFile(values.config, 'utf8')) as Record<string, unknown>) : {},
  bed: parseBed(values.bed),
  ...(values.flavor ? { flavor: values.flavor } : {}),
}
const outDir = resolve(values.out)

/** Connects to the hub only when queueing was asked for. */
async function connectHub(): Promise<(QueueTarget & { close(): void }) | null> {
  if (!values.queue) return null
  const code = process.env['SX_LINK_CODE']
  if (!code) throw new Error('--queue needs the hub app code in SX_LINK_CODE (run `sx-link code` on the hub machine).')
  const { connectLink } = await import('@slicerx/link-client')
  return connectLink({ url: values.hub, code, ...(values['hub-key'] ? { hubKey: values['hub-key'] } : {}) })
}

/** Waits until a file stops growing, so a model still being copied in is not sliced half written. */
async function settled(path: string): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    const a = (await stat(path)).size
    await new Promise((r) => setTimeout(r, 300))
    const b = (await stat(path)).size
    if (a === b && b > 0) return true
  }
  return false
}

async function sliceAll(jobs: Job[]): Promise<Sliced[]> {
  const done: Sliced[] = []
  for (const job of jobs) {
    try {
      if (!(await settled(job.model))) {
        console.error(`${job.name}: still being written, skipped for now`)
        continue
      }
      const r = await sliceModel(values.sx, job.model, job.outDir, settings)
      console.log(describe(job.name, r))
      for (const w of r.warnings) console.log(`  warning: ${w.message}`)
      done.push({ name: job.name, gcodePath: r.files?.gcode ?? join(job.outDir, 'slice.gcode') })
    } catch (e) {
      console.error(`${job.name}: ${(e as Error).message}`)
      process.exitCode = 1
    }
  }
  return done
}

const hub = await connectHub()

async function pass(): Promise<void> {
  const jobs = []
  for (const j of await listJobs(inDir!, outDir)) if (await isStale(j)) jobs.push(j)
  if (jobs.length === 0) return
  const sliced = await sliceAll(jobs)
  if (hub && values.queue) await queuePlates(hub, values.queue, sliced, askTerminal)
}

await pass()

if (values.watch) {
  console.log(`Watching ${resolve(inDir)} for new or changed models. Press Ctrl+C to stop.`)
  let timer: NodeJS.Timeout | undefined
  let running = Promise.resolve()
  watch(inDir, () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      running = running.then(pass).catch((e: unknown) => console.error((e as Error).message))
    }, 1000)
  })
} else {
  hub?.close()
}
