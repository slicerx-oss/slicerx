#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// One report page for several gate runs, for example Windows and Linux from one machine and macOS from another:
// reads each run folder's results.json, copies its screenshots under <out>/<platform>/, and writes <out>/report.html
// with one table of every scenario on every platform.
//   node scripts/gate/report.mjs --out <dir> <run folder> [<run folder>...]
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { renderReport, runStatus } from './lib/report.mjs'

const { values, positionals } = parseArgs({ options: { out: { type: 'string' } }, allowPositionals: true, strict: true })
if (!values.out || !positionals.length) {
  process.stderr.write('usage: node scripts/gate/report.mjs --out <dir> <run folder> [<run folder>...]\n')
  process.exit(2)
}
const out = resolve(values.out)
mkdirSync(out, { recursive: true })
const runs = []
const folders = new Map()
for (const dir of positionals.map((p) => resolve(p))) {
  const file = join(dir, 'results.json')
  if (!existsSync(file)) {
    process.stderr.write(`no results.json in ${dir}\n`)
    process.exit(2)
  }
  const run = JSON.parse(readFileSync(file, 'utf8'))
  let name = run.platform
  for (let i = 2; [...folders.values()].includes(name); i++) name = `${run.platform}-${i}`
  folders.set(run, name)
  if (existsSync(join(dir, 'shots'))) cpSync(join(dir, 'shots'), join(out, name, 'shots'), { recursive: true })
  runs.push(run)
}
writeFileSync(join(out, 'report.html'), renderReport(runs, { prefix: (r) => `${folders.get(r)}/` }))
for (const r of runs) process.stdout.write(`${runStatus(r).padEnd(4)} ${r.platform}\n`)
process.stdout.write(`report: ${join(out, 'report.html')}\n`)
process.exitCode = runs.some((r) => runStatus(r) === 'FAIL') ? 1 : 0
