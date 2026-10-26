// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

// Weight of an integration target that rust-part-weights.json does not list, in seconds.
const DEFAULT_WEIGHT = 5

function integrationTargets(metadata) {
  const core = metadata.packages.find((p) => p.name === 'sx-core' && metadata.workspace_members.includes(p.id))
  if (!core) throw new Error('Missing sx-core workspace package')
  return core.targets.filter((t) => t.kind.includes('test')).map((t) => t.name).sort()
}

// Seconds of test time per sx-core integration target, plus "rest" for everything else (other crates, sx-core unit
// tests and doctests, lint and the sx-cloud build). They only need to be roughly right: a stale file makes the parts
// uneven, never incomplete.
export function loadWeights(file = new URL('./rust-part-weights.json', import.meta.url)) {
  const weights = JSON.parse(readFileSync(file, 'utf8'))
  const valid = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0
  if (!valid(weights.rest)) throw new Error('Expected a positive weight for rest')
  for (const [name, weight] of Object.entries(weights.targets ?? {})) {
    if (!valid(weight)) throw new Error(`Expected a positive weight for ${name}`)
  }
  return { rest: weights.rest, targets: weights.targets ?? {} }
}

// Every part runs this on the same commit, so they agree on the split without talking to each other: largest item
// first, each into the lightest part so far, ties to the lowest part number and the earliest name.
export function partition(metadata, count, weights) {
  if (!Number.isInteger(count) || count < 1) throw new Error('Expected a part count of 1 or more')
  const targets = integrationTargets(metadata)
  const unweighted = targets.filter((name) => !Object.hasOwn(weights.targets, name))
  const items = [{ name: 'rest', rest: true, weight: weights.rest }]
  for (const name of targets) items.push({ name, rest: false, weight: weights.targets[name] ?? DEFAULT_WEIGHT })
  items.sort((a, b) => b.weight - a.weight || Number(b.rest) - Number(a.rest) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const parts = Array.from({ length: count }, () => ({ items: [], load: 0 }))
  for (const item of items) {
    const part = parts.reduce((lightest, p) => (p.load < lightest.load ? p : lightest))
    part.items.push(item)
    part.load += item.weight
  }
  checkPartition(targets, parts)
  return { parts, unweighted }
}

// A target in no part is never tested and one in two parts is tested twice, so both refuse.
export function checkPartition(targets, parts) {
  const seen = new Map()
  for (const item of parts.flatMap((part) => part.items)) seen.set(item.rest ? '' : item.name, (seen.get(item.rest ? '' : item.name) ?? 0) + 1)
  for (const name of ['', ...targets]) {
    const label = name === '' ? 'the rest' : `integration target ${name}`
    const n = seen.get(name) ?? 0
    if (n === 0) throw new Error(`Part assignment dropped ${label}: it is in no part`)
    if (n > 1) throw new Error(`Part assignment repeated ${label}: it is in ${n} parts`)
  }
  for (const name of seen.keys()) {
    if (name !== '' && !targets.includes(name)) throw new Error(`Part assignment has an unknown integration target: ${name}`)
  }
}

export function unweightedWarning(names) {
  if (!names.length) return null
  return `warning: no weight in rust-part-weights.json for ${names.length} sx-core integration target${names.length === 1 ? '' : 's'}, using ${DEFAULT_WEIGHT} s each: ${names.join(', ')}`
}

export function describe(parts, which = parts.map((_, i) => i)) {
  return which.flatMap((i) => [
    `part ${i + 1} of ${parts.length}: weight ${parts[i].load} s, ${parts[i].items.length} items`,
    `  ${parts[i].items.map((item) => `${item.name} ${item.weight}`).join(', ')}`,
  ])
}

function partCommands(metadata, part, { of, weights }) {
  if (!Number.isInteger(of) || of < 1) throw new Error('Expected --of with a part count of 1 or more')
  if (!Number.isInteger(part) || part < 1 || part > of) throw new Error(`Expected a part from 1 to ${of}`)
  const mine = partition(metadata, of, weights ?? loadWeights()).parts[part - 1]
  const selected = mine.items.filter((item) => !item.rest).map((item) => item.name).sort()
  const rest = mine.items.some((item) => item.rest)
  return [
    ...(rest ? [
      ['test', '--locked', '--workspace', '--exclude', 'slicerx-desktop', '--exclude', 'sx-core'],
      ['test', '--locked', '-p', 'sx-core', '--lib', '--bins', '--examples'],
    ] : []),
    ...(selected.length ? [['test', '--locked', '-p', 'sx-core', ...selected.flatMap((name) => ['--test', name])]] : []),
    ...(rest ? [['test', '--locked', '-p', 'sx-core', '--doc']] : []),
  ]
}

// part is main or slow (the two Windows jobs), or a part number with options.of parts in all.
export function commands(metadata, part, options = {}) {
  if (typeof part === 'number') return partCommands(metadata, part, options)
  if (!['main', 'slow'].includes(part)) throw new Error('Expected main or slow, or a part number with --of')
  const tests = integrationTargets(metadata)
  const slow = ['firmware', 'requests']
  for (const name of slow) if (!tests.includes(name)) throw new Error(`Missing integration target: ${name}`)
  const selected = part === 'slow' ? slow : tests.filter((name) => !slow.includes(name))
  const integrations = ['test', '--locked', '-p', 'sx-core', ...selected.flatMap((name) => ['--test', name])]
  if (part === 'slow') return [integrations]
  return [
    ['test', '--locked', '--workspace', '--exclude', 'slicerx-desktop', '--exclude', 'sx-core'],
    ['test', '--locked', '-p', 'sx-core', '--lib', '--bins', '--examples'],
    ...(selected.length ? [integrations] : []),
    ['test', '--locked', '-p', 'sx-core', '--doc'],
  ]
}

// Times each test binary from cargo's stderr: a binary runs from its "Running" (or "Doc-tests") line to the next one,
// and the last one until finish().
export function createTimer(now = () => performance.now()) {
  const rows = []
  let open = null
  const finish = () => {
    if (open) rows.push({ name: open.name, source: open.source, seconds: (now() - open.start) / 1000 })
    open = null
  }
  const feed = (line) => {
    const text = line.replace(/\u001b\[[0-9;]*m/g, '')
    const run = text.match(/^\s*Running\s+(.+?)\s+\((.+)\)\s*$/)
    const doc = text.match(/^\s*Doc-tests\s+(\S+)/)
    if (!run && !doc) return
    finish()
    open = run
      ? { name: run[2].split(/[\\/]/).pop().replace(/\.exe$/, '').replace(/-[0-9a-f]{16}$/, ''), source: run[1].replaceAll('\\', '/'), start: now() }
      : { name: doc[1], source: 'doc tests', start: now() }
  }
  return { rows, feed, finish }
}

export function summary(rows, title, predicted) {
  const total = rows.reduce((sum, row) => sum + row.seconds, 0)
  const sorted = [...rows].sort((a, b) => b.seconds - a.seconds || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return [
    `### ${title}`,
    '',
    `Predicted weight ${predicted} s, measured binary time ${total.toFixed(1)} s.`,
    '',
    '| binary | source | seconds |',
    '| --- | --- | ---: |',
    ...sorted.map((row) => `| ${row.name} | ${row.source} | ${row.seconds.toFixed(1)} |`),
    '',
  ].join('\n')
}

export function writeSummary(text, env = process.env) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`)
  else console.log(text)
}

function runTimed(args, timer) {
  return new Promise((resolve, reject) => {
    const child = spawn('cargo', args, { stdio: ['inherit', 'inherit', 'pipe'] })
    createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (line) => {
      process.stderr.write(`${line}\n`)
      timer.feed(line)
    })
    child.on('error', reject)
    child.on('close', (status) => {
      timer.finish()
      resolve(status ?? 1)
    })
  })
}

function option(name) {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function main() {
  const of = option('--of') === undefined ? undefined : Number(option('--of'))
  const positional = process.argv.slice(2).filter((arg, i, all) => !arg.startsWith('--') && !['--of', '--metadata'].includes(all[i - 1]))[0]
  const part = /^\d+$/.test(positional ?? '') ? Number(positional) : positional
  const file = option('--metadata')
  let metadata
  if (file) metadata = JSON.parse(readFileSync(file, 'utf8'))
  else {
    const result = spawnSync('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1'], { encoding: 'utf8' })
    if (result.error) throw result.error
    if (result.status !== 0) {
      process.stderr.write(result.stderr)
      process.exit(result.status ?? 1)
    }
    metadata = JSON.parse(result.stdout)
  }
  if (process.argv.includes('--partition')) {
    const weights = loadWeights()
    const { parts, unweighted } = partition(metadata, of, weights)
    const warning = unweightedWarning(unweighted)
    if (warning) console.error(warning)
    console.log(describe(parts).join('\n'))
    return
  }
  if (typeof part !== 'number') {
    const plan = commands(metadata, part)
    if (process.argv.includes('--plan')) console.log(JSON.stringify(plan, null, 2))
    else for (const args of plan) {
      console.log(`cargo ${args.join(' ')}`)
      const result = spawnSync('cargo', args, { stdio: 'inherit' })
      if (result.error) throw result.error
      if (result.status !== 0) process.exit(result.status ?? 1)
    }
    return
  }
  const weights = loadWeights()
  const plan = commands(metadata, part, { of, weights })
  const { parts, unweighted } = partition(metadata, of, weights)
  const warning = unweightedWarning(unweighted)
  if (warning) console.error(warning)
  if (process.argv.includes('--plan')) {
    console.log(JSON.stringify(plan, null, 2))
    return
  }
  console.log(describe(parts, [part - 1]).join('\n'))
  const timer = createTimer()
  let status = 0
  for (const args of plan) {
    console.log(`cargo ${args.join(' ')}`)
    status = await runTimed(args, timer)
    if (status !== 0) break
  }
  writeSummary(summary(timer.rows, `Rust test binaries, ${process.env.RUNNER_OS ?? process.platform} part ${part} of ${of}`, parts[part - 1].load))
  if (status !== 0) process.exit(status)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
