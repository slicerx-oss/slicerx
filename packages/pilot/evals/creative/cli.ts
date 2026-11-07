// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// pnpm --filter @slicerx/pilot eval:creative [--prompt id,id] [--log] [--change "what changed"]
//   live: --mode live --model id --usd-in n --usd-out n [--cap-usd 1.50] [--record]
//         [--provider openai|openai-compatible] [--base-url http://127.0.0.1:11434/v1]
// The default replays the recorded replies in evals/creative/recordings, offline and with no key, and lists the
// prompts that have no recording yet. A live run asks a model and needs the model's price per million input and
// output tokens, so it can stop: no new request starts once the spend reaches the cap less the stop margin
// (CAP_USD 1.50 by default, stopping at 1.40). --record saves each live reply as that prompt's recording.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNodeTransport } from '../../src/node/index'
import { createTransportClient } from '../../src/provider/client'
import type { LlmClient } from '../../src/provider/types'
import { evalGeom } from '../geom'
import { CREATIVE_PROMPTS } from './prompts'
import { loadRecording, saveRecording } from './recordings'
import { runPrompt, scoreParts, type CreativeScore } from './run'

/** Spend at which no new request starts: the cap less this margin. */
export const STOP_MARGIN_USD = 0.1
export const DEFAULT_CAP_USD = 1.5

const here = dirname(fileURLToPath(import.meta.url))

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0) return process.argv[i + 1]
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`))
  return eq ? eq.slice(name.length + 3) : fallback
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`)

const mode = arg('mode', 'replay') === 'live' ? 'live' : 'replay'
const ids = arg('prompt')?.split(',').filter(Boolean)
const selected = ids ? CREATIVE_PROMPTS.filter((p) => ids.includes(p.id)) : CREATIVE_PROMPTS
if (!selected.length) {
  console.error(`No prompt matches "${ids?.join(',')}". Ids: ${CREATIVE_PROMPTS.map((p) => p.id).join(', ')}`)
  process.exit(2)
}

const geom = evalGeom()
let client: LlmClient | undefined
let spentUsd = 0
let stoppedForCap = false
const model = arg('model')
const provider = arg('provider', 'openai') ?? 'openai'
const capUsd = Number(arg('cap-usd', String(DEFAULT_CAP_USD)))
if (mode === 'live') {
  const local = provider === 'openai-compatible'
  const usdIn = Number(arg('usd-in', local ? '0' : ''))
  const usdOut = Number(arg('usd-out', local ? '0' : ''))
  if (!model) {
    console.error('Live mode needs --model.')
    process.exit(2)
  }
  if (!Number.isFinite(usdIn) || !Number.isFinite(usdOut) || usdIn < 0 || usdOut < 0 || (!local && usdIn + usdOut === 0)) {
    console.error('Live mode needs the model price: --usd-in and --usd-out, dollars per million input and output tokens.')
    process.exit(2)
  }
  if (!Number.isFinite(capUsd) || capUsd <= STOP_MARGIN_USD) {
    console.error(`--cap-usd must be more than the ${STOP_MARGIN_USD} stop margin.`)
    process.exit(2)
  }
  if (!geom) {
    console.error('Live mode scores the parts, so it needs the geometry engine: build packages/geom/wasm (scripts/build.sh) or sx-geom first.')
    process.exit(2)
  }
  const transport = createNodeTransport()
  if (!local && !(await transport.available(provider))) {
    console.error(`No key for ${provider}.`)
    process.exit(2)
  }
  const baseUrl = arg('base-url')
  const base = createTransportClient(transport, provider, baseUrl === undefined ? {} : { baseUrl })
  client = {
    provider,
    async *stream(req, signal) {
      if (spentUsd >= capUsd - STOP_MARGIN_USD) {
        stoppedForCap = true
        throw new Error(`stopped at $${spentUsd.toFixed(2)}, the $${capUsd.toFixed(2)} cap less the $${STOP_MARGIN_USD.toFixed(2)} margin`)
      }
      for await (const ev of base.stream({ ...req, model }, signal)) {
        if (ev.type === 'usage') spentUsd += (ev.inputTokens * usdIn + ev.outputTokens * usdOut) / 1e6
        yield ev
      }
    },
  }
}

const fmt = (name: string, c: { pass: boolean; detail: string } | undefined): string => (c ? `${name} ${c.pass ? 'ok' : 'FAIL'} (${c.detail})` : '')
const scores: { id: string; score: CreativeScore; calls: number }[] = []
const waiting: string[] = []
const skipped: string[] = []
for (const p of selected) {
  if (mode === 'live' && spentUsd >= capUsd - STOP_MARGIN_USD) {
    stoppedForCap = true
    break
  }
  let steps
  if (mode === 'replay') {
    const rec = loadRecording(p.id)
    if (rec.status === 'to-capture') {
      waiting.push(p.id)
      console.log(`NO RECORDING ${p.id.padEnd(20)} waiting for a live capture run`)
      continue
    }
    if (!geom) {
      skipped.push(p.id)
      console.log(`SKIP ${p.id.padEnd(28)} recorded (${rec.model}), but there is no geometry engine to build it`)
      continue
    }
    steps = rec.steps
  }
  const run = await runPrompt(p, { geom, ...(steps ? { steps } : {}), ...(client ? { client } : {}) })
  if (mode === 'live' && flag('record') && run.steps.length && !run.error) {
    saveRecording(p.id, { status: 'recorded', model: model ?? '', provider, capturedAt: new Date().toISOString(), steps: run.steps })
  }
  const sc = scoreParts(p, run.parsed, run.parts)
  scores.push({ id: p.id, score: sc, calls: run.calls.length })
  console.log(`${sc.pass ? 'PASS' : 'FAIL'} ${p.id.padEnd(28)} ${[fmt('parses', sc.parses), fmt('watertight', sc.watertight), fmt('bodies', sc.bodies), fmt('wall', sc.minWall), fmt('bed', sc.bedFit), fmt('clearance', sc.clearance)].filter(Boolean).join('  ')}`)
  if (run.error) console.log(`     error: ${run.error}`)
  if (stoppedForCap) break
}

const passed = scores.filter((s) => s.score.pass).length
console.log(
  `\n${mode}: ${scores.length} scored, ${passed} passed${skipped.length ? `, ${skipped.length} skipped with no geometry engine` : ''}${mode === 'live' ? `, spent $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)}` : ''}${stoppedForCap ? ' (stopped at the cost cap)' : ''}`,
)
if (waiting.length) console.log(`${waiting.length} prompt${waiting.length === 1 ? ' has' : 's have'} no recording yet: ${waiting.join(', ')}`)

if (flag('log') && scores.length) {
  const ts = new Date().toISOString()
  const modelName = mode === 'live' ? (model ?? '') : 'recorded'
  const line = {
    ts,
    loop: 'creative-eval',
    mode,
    model: modelName,
    scenarios: ids?.join(',') ?? 'creative',
    runs: 1,
    change: arg('change', ''),
    metric: 'pass_rate',
    value: Math.round((passed / scores.length) * 1000) / 10,
    pass_rate: Math.round((passed / scores.length) * 1000) / 1000,
    tool_calls_per_task: Math.round((scores.reduce((a, s) => a + s.calls, 0) / scores.length) * 10) / 10,
    unapproved_side_effects: 0,
    ...(mode === 'live' ? { usd: Math.round(spentUsd * 100) / 100 } : {}),
    per_scenario: Object.fromEntries(scores.map((s) => [s.id, [s.score.pass ? 100 : 0]])),
  }
  appendFileSync(join(here, '..', 'results.jsonl'), `${JSON.stringify(line)}\n`)
  const logMd = join(here, '..', 'LOG.md')
  // The same table the scenario runs log to (evals/LOG.md); Mean holds the pass rate here, as a percent.
  if (existsSync(logMd) && readFileSync(logMd, 'utf8').trim()) {
    appendFileSync(logMd, `| ${ts.slice(0, 16).replace('T', ' ')} | ${mode} | ${modelName} | ${line.scenarios} | 1 | ${line.value} | ${Math.round(line.pass_rate * 100)}% | ${line.tool_calls_per_task} | 0 | ${line.change || 'creative prompts'} |\n`)
  }
}

process.exit(mode === 'replay' && passed < scores.length ? 1 : 0)
