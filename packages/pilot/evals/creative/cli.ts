// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 The SlicerX contributors
// pnpm --filter @slicerx/pilot eval:creative [--prompt id,id] [--log] [--change "what changed"] [--no-default-answer]
//   live: --mode live --model id --usd-in n --usd-out n [--cap-usd 1.50] [--record]
//         [--long-above tokens --usd-in-long n --usd-out-long n] [--usd-per-search 0.01]
//         [--provider openai|anthropic|openai-compatible] [--base-url http://127.0.0.1:11434/v1]
// The default replays the recorded replies in evals/creative/recordings, offline and with no key, and lists the
// prompts that have no recording yet. A live run asks a model and needs the model's price per million input and
// output tokens, so it can stop: no new request starts once the spend reaches the cap less the stop margin
// (CAP_USD 1.50 by default, stopping at 1.40), or when the most it could cost would take the spend past the cap.
// A reply cut off before its usage arrived is charged that most. --record saves each live reply as that prompt's
// recording.
// mimir runs with the desktop tab's options (run.ts CREATIVE_TAB, the app's src/tab-options.ts). A reply that builds
// nothing is scored as asked (a question to the person), declined (says it can't model or build it) or none. When it
// asks, the eval answers once with run.ts DEFAULT_ANSWER and lets it go on; --no-default-answer turns that off. A
// replay answers only for a recording captured with the answer, and marks a recorded question without one stale.
// --provider anthropic is the API mimir's default model runs on; its key comes from ANTHROPIC_API_KEY (or
// SLICERX_ANTHROPIC_API_KEY), and its cache writes and reads are priced the way mimir cloud bills them (live.ts).
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNodeTransport } from '../../src/node/index'
import { createTransportClient } from '../../src/provider/client'
import type { LlmClient } from '../../src/provider/types'
import { evalGeom } from '../geom'
import { budgetedClient, createBudget, DEFAULT_CAP_USD, DEFAULT_USD_PER_SEARCH, runLive, STOP_MARGIN_USD, type Price } from './live'
import { CREATIVE_PROMPTS, type CreativePrompt } from './prompts'
import { loadRecording, saveRecording } from './recordings'
import { CREATIVE_TAB, DEFAULT_ANSWER, runPrompt, scoreParts, type CreativeScore, type NoBuild, type PromptRun } from './run'
import { TAB_MIN_STEPS, TAB_MIN_TOOL_CALLS } from '../../src/tab-options'

const PROVIDERS = ['openai', 'anthropic', 'openai-compatible']

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

const defaultAnswer = !flag('no-default-answer')
const answerLine = defaultAnswer ? `on ("${DEFAULT_ANSWER}")` : 'off'
console.log(`mimir as the ${CREATIVE_TAB.slices ? 'desktop' : 'browser'} tab (${CREATIVE_TAB.editionName} edition, at least ${TAB_MIN_STEPS} steps and ${TAB_MIN_TOOL_CALLS} tool calls); default answer ${answerLine}`)

const geom = evalGeom()
let client: LlmClient | undefined
const model = arg('model')
const provider = arg('provider', 'openai') ?? 'openai'
const capUsd = Number(arg('cap-usd', String(DEFAULT_CAP_USD)))
const budget = createBudget(capUsd)
if (mode === 'live') {
  const local = provider === 'openai-compatible'
  const usdIn = Number(arg('usd-in', local ? '0' : ''))
  const usdOut = Number(arg('usd-out', local ? '0' : ''))
  const longAbove = arg('long-above')
  const usdPerSearch = Number(arg('usd-per-search', local ? '0' : String(DEFAULT_USD_PER_SEARCH)))
  const price: Price = { usdIn, usdOut, usdPerSearch }
  if (!Number.isFinite(usdPerSearch) || usdPerSearch < 0) {
    console.error('--usd-per-search is dollars per hosted web search, 0 or more.')
    process.exit(2)
  }
  if (!PROVIDERS.includes(provider)) {
    console.error(`Unknown --provider "${provider}". Use ${PROVIDERS.join(', ')}.`)
    process.exit(2)
  }
  if (longAbove !== undefined) {
    const long = { above: Number(longAbove), usdIn: Number(arg('usd-in-long', '')), usdOut: Number(arg('usd-out-long', '')) }
    if (![long.above, long.usdIn, long.usdOut].every((n) => Number.isFinite(n) && n > 0)) {
      console.error('--long-above needs a token count, and --usd-in-long and --usd-out-long the rates above it.')
      process.exit(2)
    }
    price.long = long
  }
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
    console.error(`No key for ${provider}${provider === 'anthropic' ? ': set ANTHROPIC_API_KEY' : ''}.`)
    process.exit(2)
  }
  const baseUrl = arg('base-url')
  const base = createTransportClient(transport, provider, baseUrl === undefined ? {} : { baseUrl })
  client = budgetedClient(base, model, price, budget)
}

const fmt = (name: string, c: { pass: boolean; detail: string } | undefined): string => (c ? `${name} ${c.pass ? 'ok' : 'FAIL'} (${c.detail})` : '')
const scores: { id: string; score: CreativeScore; calls: number; noBuild?: NoBuild; answered: boolean }[] = []
const waiting: string[] = []
const skipped: string[] = []
const stale: string[] = []
const report = (p: CreativePrompt, run: PromptRun): void => {
  if (mode === 'live' && flag('record') && run.steps.length && !run.error) {
    saveRecording(p.id, { status: 'recorded', model: model ?? '', provider, capturedAt: new Date().toISOString(), steps: run.steps, ...(defaultAnswer ? { defaultAnswer: true } : {}) })
  }
  const sc = scoreParts(p, run.parsed, run.parts)
  scores.push({ id: p.id, score: sc, calls: run.calls.length, answered: run.answered, ...(run.noBuild ? { noBuild: run.noBuild } : {}) })
  const checks = run.noBuild ? `no build: ${run.noBuild}${run.answered ? ' after the default answer' : ''}` : [fmt('parses', sc.parses), fmt('watertight', sc.watertight), fmt('bodies', sc.bodies), fmt('wall', sc.minWall), fmt('bed', sc.bedFit), fmt('clearance', sc.clearance)].filter(Boolean).join('  ')
  console.log(`${(sc.pass ? 'PASS' : run.noBuild ? run.noBuild.toUpperCase() : 'FAIL').padEnd(8)} ${p.id.padEnd(28)} ${checks}${run.answered && !run.noBuild ? '  (built after the default answer)' : ''}`)
  if (run.stale) {
    stale.push(p.id)
    console.log(`     STALE recording: ${run.stale}`)
  }
  if (run.error) console.log(`     error: ${run.error}`)
}
if (client) {
  for await (const { prompt, run } of runLive(selected, { geom, client, budget, defaultAnswer })) report(prompt, run)
} else {
  for (const p of selected) {
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
    report(p, await runPrompt(p, { geom, steps: rec.steps, defaultAnswer, answerRecorded: rec.defaultAnswer === true }))
  }
}

const passed = scores.filter((s) => s.score.pass).length
const noBuild = (r: NoBuild): string[] => scores.filter((s) => s.noBuild === r).map((s) => s.id)
const nothing = scores.filter((s) => s.noBuild).length
const answeredIds = scores.filter((s) => s.answered).map((s) => s.id)
const noBuildLine = nothing ? `${nothing} built nothing (${noBuild('asked').length} asked, ${noBuild('declined').length} declined, ${noBuild('none').length} none)` : ''
console.log(
  `\n${mode}: ${scores.length} scored, ${passed} passed${skipped.length ? `, ${skipped.length} skipped with no geometry engine` : ''}${mode === 'live' ? `, spent $${budget.spentUsd.toFixed(2)} of $${capUsd.toFixed(2)}${budget.cutOff ? ` ($${budget.estimatedUsd.toFixed(2)} of it the most ${budget.cutOff} cut-off repl${budget.cutOff === 1 ? 'y' : 'ies'} could cost)` : ''}` : ''}${budget.stopped ? ' (stopped at the cost cap)' : ''}`,
)
if (noBuildLine) console.log(noBuildLine)
console.log(`default answer ${defaultAnswer ? `on, given in ${answeredIds.length} run${answeredIds.length === 1 ? '' : 's'}${answeredIds.length ? `: ${answeredIds.join(', ')}` : ''}` : 'off'}`)
if (stale.length) console.log(`${stale.length} stale recording${stale.length === 1 ? '' : 's'}, to capture again live: ${stale.join(', ')}`)
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
    ...(mode === 'live' ? { usd: Math.round(budget.spentUsd * 100) / 100 } : {}),
    per_scenario: Object.fromEntries(scores.map((s) => [s.id, [s.score.pass ? 100 : 0]])),
    default_answer: defaultAnswer,
    answered: answeredIds,
    no_build: Object.fromEntries(scores.flatMap((s) => (s.noBuild ? [[s.id, s.noBuild]] : []))),
    ...(stale.length ? { stale } : {}),
  }
  appendFileSync(join(here, '..', 'results.jsonl'), `${JSON.stringify(line)}\n`)
  const logMd = join(here, '..', 'LOG.md')
  // The same table the scenario runs log to (evals/LOG.md); Mean holds the pass rate here, as a percent.
  if (existsSync(logMd) && readFileSync(logMd, 'utf8').trim()) {
    const notes = [line.change || 'creative prompts', `default answer ${defaultAnswer ? `on (${answeredIds.length} answered)` : 'off'}`, noBuildLine ? `${noBuildLine}: ${(['asked', 'declined', 'none'] as const).flatMap((r) => noBuild(r).map((id) => `${id} ${r}`)).join(', ')}` : '', stale.length ? `stale: ${stale.join(', ')}` : '']
    appendFileSync(logMd, `| ${ts.slice(0, 16).replace('T', ' ')} | ${mode} | ${modelName} | ${line.scenarios} | 1 | ${line.value} | ${Math.round(line.pass_rate * 100)}% | ${line.tool_calls_per_task} | 0 | ${notes.filter(Boolean).join('; ')} |\n`)
  }
}

process.exit(mode === 'replay' && passed < scores.length ? 1 : 0)
